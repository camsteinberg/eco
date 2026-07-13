// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Download — core fetch loop.
 *
 * Focused orchestrator built on top of the `Storage` abstraction.
 *
 * Design notes:
 *
 *   - Sizes come from the plan. The plan is the contract — callers pass
 *     in `DownloadPlan = { modelId; files: [{ url; sizeBytes }] }`. That
 *     means the orchestrator never needs to HEAD a file just to learn
 *     its size.
 *
 *   - Resumable via storage. Before fetching, the orchestrator asks
 *     `storage.verify(key, sizeBytes)`. A verified entry is reused. A
 *     missing or size-mismatched entry is refetched and `storage.put`
 *     overwrites the prior bytes — byte-tagging means the next `verify`
 *     call will reflect the new state honestly.
 *
 *   - Progress comes from the body stream. The fetch Response.body is
 *     read as a ReadableStream<Uint8Array>; each chunk advances `loaded`
 *     and is forwarded through the progress emitter. Aggregated chunks
 *     are reassembled into a Response that gets passed to `storage.put`.
 *
 *   - One in-flight download per modelId. Concurrent calls for the same
 *     `modelId` share the same AbortController; `cancelDownload(modelId)`
 *     aborts the active operation.
 *
 *   - DI seam for the plan resolver. `downloadModel(model)` calls a
 *     resolver injected at boot (or by tests). Until a resolver is set,
 *     `downloadModel` throws an informative error. The pure path
 *     `downloadByPlan` is the unit-testable surface and does not depend
 *     on the resolver.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ModelConfig } from '../types';
import {
  pickStorage,
  type Storage,
} from './storage';
import { requestPersistentStorage } from './persistent-storage';
import { ProgressTracker, type ProgressTrackerOptions } from './progress';
import { getDeviceProfile } from '../device/profile';
import { recordEvidence, type LedgerErrorCode } from '../evidence/ledger';
import { getValidationDownloadFailure } from '../../lib/validation-harness';

// ─── Plan + options ─────────────────────────────────────────────────────────

export type DownloadFileSpec = {
  /**
   * Stable storage identity for this file — the same-origin proxy path. Used as
   * the Cache/OPFS key by storage.put/verify/has/remove AND by the LiteRT
   * adapter's cache lookup, so it must NOT change with the transport source:
   * keeping it stable means toggling the CDN flag (or the kill-switch back to
   * the proxy) never invalidates already-downloaded files.
   */
  url: string;
  /**
   * The URL to actually FETCH the bytes from. Defaults to `url` (the proxy).
   * When the R2 CDN is configured the plan builder sets this to the direct CDN
   * URL while leaving `url` (the identity) untouched. The HF path layout is
   * identical on both, so integrity (client SHA-256 vs the manifest `oid`)
   * holds regardless of source.
   */
  fetchUrl?: string;
  /** Expected size in bytes. Drives both storage.verify() and the stream total. */
  sizeBytes: number;
  /**
   * Reviewed Hugging Face object id from the manifest. A 64-hex value is an
   * LFS SHA-256 of the file contents — used to verify the assembled bytes when
   * the file is downloaded in Range chunks (chunked requests bypass the proxy's
   * full-GET SHA verification). Absent on the heuristic-fallback plan, in which
   * case chunked downloads are size-verified only.
   */
  oid?: string;
};

/**
 * Files larger than this download via sequential HTTP Range requests rather
 * than one long streaming GET.
 *
 * Why: the model proxy is a Vercel `nodejs` function with a bounded execution
 * time. A single ~2 GB streaming GET (e.g. Gemma's `.litertlm`) outlives that
 * budget on any non-fast connection and the function is killed mid-stream →
 * `Failed to fetch` at phase:download, which broke the f16-less default. Each
 * Range request transfers at most one chunk, so its duration is bounded by
 * chunk size ÷ connection speed regardless of total file size, and the
 * download as a whole can take as long as it needs across many short requests.
 *
 * 32 MiB keeps each request comfortably inside any plausible function budget
 * (a chunk only exceeds 300 s below ~110 KB/s — a link that could never finish
 * a 2 GB file anyway) while keeping the request count modest (~64 for 2 GB).
 */
export const RANGE_CHUNK_BYTES = 32 * 1024 * 1024;

/** Extra attempts per chunk on a transient (non-abort, non-4xx) failure. */
const MAX_CHUNK_RETRIES = 2;

export type DownloadPlan = {
  modelId: string;
  files: ReadonlyArray<DownloadFileSpec>;
};

export type DownloadOptions = {
  signal?: AbortSignal;
  /** Inject storage (defaults to `pickStorage({ preferOpfs: false })`). */
  storage?: Storage;
  /** Inject fetch (defaults to global `fetch`). Useful for tests. */
  fetcher?: typeof fetch;
  /** Reuse a pre-existing tracker. If absent, a fresh tracker is created and exposed via the resolved options. */
  tracker?: ProgressTracker;
  /** Options forwarded to a freshly-created ProgressTracker. */
  progressOptions?: ProgressTrackerOptions;
  /** Override the Range-chunk threshold/size (defaults to RANGE_CHUNK_BYTES). Tests use a tiny value. */
  rangeChunkBytes?: number;
  /**
   * Inject the storage-headroom probe (defaults to `navigator.storage.estimate`).
   * Returns null when no confident estimate is available — the preflight then
   * fails open and the download proceeds.
   */
  estimateStorage?: () => Promise<StorageHeadroom | null>;
};

export type StorageHeadroom = { usage: number; quota: number };

/**
 * Require the available origin budget to exceed the remaining bytes by this
 * factor before downloading — a small cushion for storage overhead and the
 * approximate nature of `estimate()`. The case this guards (incognito's tiny
 * quota vs a ~2 GB model) fails by a wide margin, so the exact factor is not
 * load-bearing; it only avoids false declines near the boundary.
 */
const STORAGE_HEADROOM_FACTOR = 1.1;

export type DownloadResult = {
  modelId: string;
  bytesDownloaded: number;
  filesFetched: number;
  filesSkipped: number;
  tracker: ProgressTracker;
};

// ─── Public errors ──────────────────────────────────────────────────────────

export class DownloadAbortedError extends Error {
  constructor(modelId: string) {
    super(`Download aborted for ${modelId}`);
    this.name = 'DownloadAbortedError';
  }
}

export class DownloadFailedError extends Error {
  readonly status?: number;
  readonly url: string;
  constructor(message: string, opts: { url: string; status?: number }) {
    super(message);
    this.name = 'DownloadFailedError';
    this.url = opts.url;
    this.status = opts.status;
  }
}

/**
 * Raised when a Range-chunked download assembles fully but its SHA-256 does
 * not match the reviewed manifest oid. A subclass of DownloadFailedError so
 * existing download-failure handling (cascade retry, phase classification)
 * treats it uniformly, while the distinct name keeps it legible in diagnostics.
 */
export class DownloadIntegrityError extends DownloadFailedError {
  constructor(message: string, opts: { url: string }) {
    super(message, opts);
    this.name = 'DownloadIntegrityError';
  }
}

/**
 * Raised when there is not enough on-device storage to hold the model's
 * weights — caught up-front by a `navigator.storage.estimate()` preflight, or
 * from a `QuotaExceededError` mid-write. Distinct from a transient network
 * failure: retrying the same model can't help (the setup cascade may still fit
 * a smaller model, and only shows this honest message once nothing fits). The
 * message is user-facing and factual — it drives the storage copy in
 * SetupErrorState. Carries the byte figures for diagnostics.
 */
export class InsufficientStorageError extends Error {
  readonly requiredBytes: number;
  readonly availableBytes?: number;
  constructor(requiredBytes: number, availableBytes?: number) {
    super(insufficientStorageMessage(requiredBytes, availableBytes));
    this.name = 'InsufficientStorageError';
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
  }
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

function insufficientStorageMessage(required: number, available?: number): string {
  return available != null
    ? `Eco needs about ${formatGiB(required)} of free space for this model, but only about `
      + `${formatGiB(available)} is available on this device.`
    : `Eco ran out of free space while setting up this model — it needs about `
      + `${formatGiB(required)}.`;
}

export class DownloadResolverMissingError extends Error {
  constructor() {
    super(
      'No download plan resolver is registered. Call setDownloadPlanResolver at app boot. '
      + 'For unit tests, call downloadByPlan() directly.',
    );
    this.name = 'DownloadResolverMissingError';
  }
}

// ─── In-flight registry ─────────────────────────────────────────────────────

type ActiveDownload = {
  controller: AbortController;
  tracker: ProgressTracker;
};

const inFlight = new Map<string, ActiveDownload>();

/** Snapshot of currently-active downloads. Test/debug surface. */
export function listActiveDownloads(): string[] {
  return Array.from(inFlight.keys());
}

/**
 * Abort the in-flight download for `modelId`, if any. Idempotent — calling
 * twice or for an unknown modelId is a no-op.
 */
export async function cancelDownload(modelId: string): Promise<void> {
  const entry = inFlight.get(modelId);
  if (!entry) return;
  entry.controller.abort();
  // The downloadByPlan loop is responsible for clearing inFlight on exit;
  // we don't delete here so a concurrent caller observing inFlight sees
  // the entry until the loop unwinds.
}

// ─── Plan resolver DI seam ──────────────────────────────────────────────────

export type DownloadPlanResolver = (model: ModelConfig) => Promise<DownloadPlan>;

let downloadPlanResolver: DownloadPlanResolver | null = null;

/**
 * Register the resolver that turns a `ModelConfig` into a `DownloadPlan`.
 *
 * Wired once on app boot with a real manifest fetcher. Tests register a
 * fixture resolver. Calling with `null` clears the registration (use in
 * test teardown).
 */
export function setDownloadPlanResolver(resolver: DownloadPlanResolver | null): void {
  downloadPlanResolver = resolver;
}

/** Test/debug accessor — returns whether a resolver is currently set. */
export function hasDownloadPlanResolver(): boolean {
  return downloadPlanResolver != null;
}

/**
 * Resolve a model's plan WITHOUT executing the download. Used by
 * self-heal's boot reconciliation pass — it needs the file list to
 * verify cached entries against, but does not want the side effects of
 * a real download. Returns null when no resolver is registered.
 */
export async function peekDownloadPlan(model: ModelConfig): Promise<DownloadPlan | null> {
  if (!downloadPlanResolver) return null;
  return downloadPlanResolver(model);
}

/**
 * True when EVERY file in the model's download plan verifies in storage
 * (size-stamped byte check — the same verify the download loop trusts for
 * its skip pass). Used by the instant-start paths: the returning-user fast
 * path (a fully-cached class-best must never be downgraded to a starter)
 * and the upgrade machine's staged-state check. Fails closed: no resolver,
 * an empty plan, or a probe error all read as "not cached" — the caller
 * then takes the download path, where verify-skip makes a false negative
 * cost only the probe.
 */
export async function isModelFullyCached(
  model: ModelConfig,
  options?: Pick<DownloadOptions, 'storage'>,
): Promise<boolean> {
  try {
    const plan = await peekDownloadPlan(model);
    if (!plan || plan.files.length === 0) return false;
    const storage = options?.storage ?? pickStorage();
    for (const file of plan.files) {
      const verified = await storage.verify(
        { modelId: plan.modelId, url: file.url },
        file.sizeBytes,
      );
      if (!verified) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ─── High-level entry: downloadModel ────────────────────────────────────────

/**
 * Resolve a plan for `model` via the registered resolver and download it.
 * Called from `hooks/local-ai/useEcoSetup.ts`.
 */
export async function downloadModel(
  model: ModelConfig,
  options?: DownloadOptions,
): Promise<DownloadResult> {
  if (!downloadPlanResolver) {
    throw new DownloadResolverMissingError();
  }
  const plan = await downloadPlanResolver(model);
  // Single choke point (slice 3): setup, switch-model, and the upgrade driver
  // all fund their downloads through here, so recording the failure ONCE at
  // this origin is what makes double-counting impossible — no caller re-writes
  // a download-fail row.
  try {
    return await downloadByPlan(plan, options);
  } catch (err) {
    if (!options?.signal?.aborted) recordDownloadFailure(model, err);
    throw err;
  }
}

/** Map a thrown download error onto the ledger's failure taxonomy. */
function classifyDownloadError(err: unknown): LedgerErrorCode {
  if (err instanceof InsufficientStorageError) return 'insufficient-storage';
  // DownloadIntegrityError extends DownloadFailedError — check the subclass first.
  if (err instanceof DownloadIntegrityError) return 'integrity';
  if (err instanceof DownloadFailedError) return 'failed';
  return 'failed';
}

/**
 * Record a durable `download-fail` ledger row at the failure origin. Aborts are
 * resumable user/tab cancels — never a failure — so they are skipped, keeping
 * them out of the recommender's demotion count. Best-effort: observability must
 * never break the download path.
 */
function recordDownloadFailure(model: ModelConfig, err: unknown): void {
  if (err instanceof DownloadAbortedError) return;
  try {
    recordEvidence({
      modelId: model.id,
      profile: getDeviceProfile(),
      outcome: 'download-fail',
      errorCode: classifyDownloadError(err),
    });
  } catch {
    // Swallow — a ledger write must never turn a download failure into a crash.
  }
}

// ─── Validation-harness seam (dev-only) ─────────────────────────────────────

/**
 * Inject a real, typed download failure when a browser validator has forced one
 * via `eco-force-download`. This is the ONLY place the download path reads the
 * harness, and it fails at a faithful point — the top of the fetch phase, after
 * the verify/skip and headroom preflight but before any network work — so the
 * setup cascade (retry → demote), exhaustion ladder, and SetupErrorState flow
 * are exercised with the same error classes a genuinely broken device or host
 * would raise.
 *
 * Faithfulness of the mapping (kept so `SetupErrorState`'s copy branches fire
 * as they would in the wild):
 *   - `storage` → `InsufficientStorageError` with byte figures, exactly as the
 *     `assertStorageHeadroom` preflight raises it.
 *   - `quota`   → `InsufficientStorageError` without an available figure, exactly
 *     as the mid-write `QuotaExceededError` catch converts it.
 *   - `hosting` → HTTP-shaped `DownloadFailedError`, as a non-OK response does.
 *   - `cache` / `opfs` → the raw backend write error a failing `storage.put`
 *     rethrows (there is no dedicated class for these — a plain `Error`, which
 *     classifies as a generic `failed`, is what the real backends surface).
 *
 * Inert in production and whenever the seam is unset:
 * `getValidationDownloadFailure()` is `'none'` unless the harness is enabled
 * (loopback / non-prod / explicit flag), so this returns immediately with no
 * effect on the shipping download path.
 */
function injectForcedDownloadFailure(remainingBytes: number): void {
  const mode = getValidationDownloadFailure();
  if (mode === 'none') return;

  // Plausible weight size for the storage-shortage copy when the seam runs on a
  // device that actually has room: the model's own remaining bytes if known,
  // else a representative ~2 GB weight.
  const requiredBytes = remainingBytes > 0 ? remainingBytes : 2_100_000_000;

  switch (mode) {
    case 'storage':
      // Only a sliver of the required space is free — mirrors the preflight.
      throw new InsufficientStorageError(requiredBytes, Math.round(requiredBytes * 0.18));
    case 'quota':
      throw new InsufficientStorageError(requiredBytes);
    case 'hosting':
      throw new DownloadFailedError('HTTP 500 fetching model weights from the host', {
        url: 'https://models.econetwork.ai/(eco-force-download=hosting)',
        status: 500,
      });
    case 'cache':
      // Deliberately free of the storage-shortage keywords: a Cache API write
      // failure is not necessarily a space problem (that is `quota`).
      throw new Error("Couldn't write the model file to the browser cache.");
    case 'opfs':
      throw new Error("Couldn't write the model file to the on-device file system.");
  }
}

// ─── Core orchestrator: downloadByPlan ──────────────────────────────────────

/**
 * Download every file in `plan` through Eco's storage layer.
 *
 * - Pre-existing entries that pass `storage.verify(file)` are skipped.
 * - Remaining files are fetched in order. Each fetch streams its body
 *   through the progress tracker and writes the assembled bytes via
 *   `storage.put`. `storage.put` stamps `Eco-Cache-Size` on write —
 *   the next `verify` reads exactly that header and never falls back
 *   to `content-length`. This is what makes the legacy size-trust bug
 *   structurally impossible.
 * - On abort: the in-flight fetch is cancelled and no partial entry is
 *   stamped. Already-verified files from this run remain in storage —
 *   that's the resumable property.
 */
export async function downloadByPlan(
  plan: DownloadPlan,
  options?: DownloadOptions,
): Promise<DownloadResult> {
  if (inFlight.has(plan.modelId)) {
    throw new Error(
      `A download for ${plan.modelId} is already in flight. Call cancelDownload first.`,
    );
  }

  const tracker = options?.tracker ?? new ProgressTracker(options?.progressOptions);
  const storage = options?.storage ?? pickStorage();
  // Bind the default to the global: the fetch loop holds this on a ctx object
  // and calls it as `ctx.fetcher(...)`, and native fetch throws "Illegal
  // invocation" if its receiver isn't the global (injected test fakes don't
  // brand-check, so this only bites in a real browser).
  const fetcher = options?.fetcher ?? fetch.bind(globalThis);
  const rangeChunkBytes = options?.rangeChunkBytes ?? RANGE_CHUNK_BYTES;
  const estimateStorage = options?.estimateStorage ?? defaultEstimateStorage;
  const externalSignal = options?.signal;
  const controller = new AbortController();

  const onExternalAbort = (): void => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const totalBytes = plan.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  let loadedBytes = 0;
  let filesFetched = 0;
  let filesSkipped = 0;

  try {
    // Register inside the try/finally so the registry entry is always
    // paired with its inFlight.delete in finally — even if any of the
    // setup statements between here and the first await throw.
    inFlight.set(plan.modelId, { controller, tracker });
    // Fire-and-forget: ask the browser to shield this origin's storage from
    // disk-pressure eviction (Chrome wiped every model cache at ~872MB free,
    // 2026-06-11). The download is the moment of user intent to store large
    // weights; the request is memoized, best-effort, and never blocks or
    // fails the download (see persistent-storage.ts).
    void requestPersistentStorage();
    // First pass: verify cached state and tally already-loaded bytes.
    const remaining: DownloadFileSpec[] = [];
    for (const file of plan.files) {
      throwIfAborted(controller.signal, plan.modelId);
      const verified = await storage.verify(
        { modelId: plan.modelId, url: file.url },
        file.sizeBytes,
      );
      if (verified) {
        loadedBytes += file.sizeBytes;
        filesSkipped += 1;
        tracker.reportDownloadProgress(loadedBytes, totalBytes);
        continue;
      }
      remaining.push(file);
    }

    // Storage preflight: decline up-front when there isn't room for the bytes
    // we're about to write, so the user gets an honest "not enough space"
    // message instead of a mid-download QuotaExceededError (or, in incognito,
    // a doomed download that can never finish). Fails open when no confident
    // estimate is available — real corruption is still caught downstream.
    const remainingBytes = remaining.reduce((sum, file) => sum + file.sizeBytes, 0);
    await assertStorageHeadroom(remainingBytes, estimateStorage);

    // Dev-only validation seam: only when there is something to fetch (a
    // fully-cached model has no download to fail). No-op in production.
    if (remaining.length > 0) {
      injectForcedDownloadFailure(remainingBytes);
    }

    // Second pass: fetch + store the missing files, streaming each body
    // straight into a (disk-backed) Blob so we never hold a whole file — let
    // alone a 2–3× materialization of it — in the JS heap. The old path
    // accumulated every chunk, allocated ONE contiguous Uint8Array for the
    // whole file, then copied it AGAIN in stampCacheSize() → a ~2–3× peak that
    // throws `RangeError: Array buffer allocation failed` on large single-file
    // weights (e.g. a 1.1 GB .onnx_data) on memory-constrained devices.
    // `new Response(stream).blob()` keeps the JS heap at O(chunk): the browser
    // streams the body into Blob storage (which spills to disk). storage.put()
    // then stamps the ACTUAL blob size, so the size-trust contract (verify
    // reads only Eco-Cache-Size) and the heuristic-plan-size tolerance (no
    // throw on size mismatch — verify catches it on the next pass) are
    // unchanged.
    const fetchContext: FetchFileContext = {
      fetcher,
      tracker,
      totalBytes,
      signal: controller.signal,
      modelId: plan.modelId,
      rangeChunkBytes,
    };
    for (const file of remaining) {
      throwIfAborted(controller.signal, plan.modelId);

      const blob = await fetchFileToBlobWithFallback(file, loadedBytes, fetchContext);

      loadedBytes += blob.size;

      try {
        await storage.put(
          { modelId: plan.modelId, url: file.url },
          new Response(blob),
        );
      } catch (err) {
        // A late quota failure (estimate was optimistic, or space vanished
        // mid-download) becomes the same honest storage error as the preflight.
        if (isQuotaExceeded(err)) throw new InsufficientStorageError(remainingBytes);
        throw err;
      }
      filesFetched += 1;
    }

    // Final progress flush so the consumer sees exactly 1.0 on completion.
    tracker.reportDownloadProgress(totalBytes, totalBytes);

    return {
      modelId: plan.modelId,
      bytesDownloaded: loadedBytes,
      filesFetched,
      filesSkipped,
      tracker,
    };
  } finally {
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    inFlight.delete(plan.modelId);
  }
}

// ─── Internals ──────────────────────────────────────────────────────────────

function throwIfAborted(signal: AbortSignal, modelId: string): void {
  if (signal.aborted) {
    throw new DownloadAbortedError(modelId);
  }
}

/**
 * Stream a response body into a Blob, reporting progress per chunk.
 *
 * Memory: a progress-counting TransformStream forwards each chunk into
 * `new Response(stream).blob()`. The browser accumulates the body in Blob
 * storage (disk-backed for large blobs) rather than the JS heap, so peak heap
 * stays at O(chunk) regardless of file size. The Blob's `.size` is the
 * authoritative byte count that storage.put() stamps as Eco-Cache-Size.
 *
 * Abort: the body stream is tied to `signal` via the fetch controller, so an
 * abort rejects the in-flight `.blob()`; we surface DownloadAbortedError.
 * Size mismatches are intentionally NOT failed here — see the second-pass
 * comment in downloadByPlan.
 */
async function streamResponseToBlob(
  response: Response,
  baseLoaded: number,
  totalBytes: number,
  tracker: ProgressTracker,
  signal: AbortSignal,
  modelId: string,
  url: string,
): Promise<Blob> {
  if (!response.body) {
    // Fallback when the runtime cannot stream (jsdom under some configs).
    // We still get progress at the file boundary.
    const blob = await response.blob();
    tracker.reportDownloadProgress(baseLoaded + blob.size, totalBytes);
    return blob;
  }

  let received = 0;
  const progress = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      tracker.reportDownloadProgress(baseLoaded + received, totalBytes);
      controller.enqueue(chunk);
    },
  });

  try {
    return await new Response(response.body.pipeThrough(progress)).blob();
  } catch (err) {
    if (signal.aborted) throw new DownloadAbortedError(modelId);
    throw new DownloadFailedError(
      `Network error streaming ${url}: ${errorMessage(err)}`,
      { url },
    );
  }
}

// ─── Per-file fetch dispatch ────────────────────────────────────────────────

type FetchFileContext = {
  fetcher: typeof fetch;
  tracker: ProgressTracker;
  totalBytes: number;
  signal: AbortSignal;
  modelId: string;
  rangeChunkBytes: number;
};

/**
 * Fetch one file into a (disk-backed) Blob. Files above the chunk threshold
 * stream via sequential Range requests so no single request can outlive the
 * proxy function budget; smaller files keep the single-GET path (which also
 * gets the proxy's full-GET SHA verification for free).
 */
async function fetchFileToBlob(
  file: DownloadFileSpec,
  baseLoaded: number,
  ctx: FetchFileContext,
): Promise<Blob> {
  if (file.sizeBytes > ctx.rangeChunkBytes) {
    return downloadFileInChunks(file, baseLoaded, ctx);
  }
  return downloadFileWhole(file, baseLoaded, ctx);
}

/**
 * Fetch one file, falling back from the CDN to the same-origin proxy on a
 * transport failure.
 *
 * A file's bytes are normally pulled from `file.fetchUrl` (the direct R2 CDN
 * URL when configured); `file.url` is the stable same-origin proxy path — Eco's
 * own re-emit of the HF object, which always resolves. A CDN outage should not
 * fail the download when the proxy can still serve, so on a transport-level
 * error (5xx/408/429/network, or a CDN serving corrupt bytes) this retries ONCE
 * against the proxy by pinning `fetchUrl` to `url`.
 *
 * This is a second recovery axis, distinct from the per-chunk retry inside
 * `fetchRangeChunk`: that retries the SAME source on a blip; this switches
 * SOURCE after those retries are spent (chunked) or immediately (whole-file).
 * It composes with — and does not consume — the setup cascade's one
 * model-level retry, so a whole download attempt can survive a dead CDN.
 *
 * Integrity is unchanged: the proxy attempt is a normal `fetchFileToBlob`, so
 * its assembled bytes are SHA-verified against `file.oid` before storage exactly
 * as the CDN attempt would be, and the storage identity stays `file.url`.
 */
async function fetchFileToBlobWithFallback(
  file: DownloadFileSpec,
  baseLoaded: number,
  ctx: FetchFileContext,
): Promise<Blob> {
  try {
    return await fetchFileToBlob(file, baseLoaded, ctx);
  } catch (err) {
    if (!shouldFallbackToProxy(err, file, ctx.signal)) throw err;
    console.warn('[eco] CDN fetch failed, falling back to proxy', { url: file.url });
    // Pin the transport source to the stable proxy identity for the retry. If
    // this attempt also fails, its error propagates normally (no third try).
    return fetchFileToBlob({ ...file, fetchUrl: file.url }, baseLoaded, ctx);
  }
}

/**
 * Whether a failed CDN fetch of `file` should be retried against the proxy.
 *
 * False (rethrow the original error) when:
 *   - the download was aborted (a user/tab cancel is not a transport failure);
 *   - no distinct CDN is in use (`fetchUrl` unset or equal to `url`), so the
 *     proxy IS the source that just failed — a retry cannot differ;
 *   - the error is a hard 4xx (missing/forbidden object): the same path won't
 *     resolve on the proxy either. 408/429 are excluded — those are transient;
 *   - the error is non-transport (e.g. `InsufficientStorageError`): a different
 *     source can't create disk space.
 *
 * True (fall back) for a `DownloadFailedError` carrying a 5xx/408/429 status or
 * no status (a network error), and for a `DownloadIntegrityError` — a CDN
 * serving corrupt bytes is worth re-fetching through the proxy, whose full-GET
 * path carries a server-side SHA guard.
 */
function shouldFallbackToProxy(
  err: unknown,
  file: DownloadFileSpec,
  signal: AbortSignal,
): boolean {
  if (signal.aborted) return false;
  if (err instanceof DownloadAbortedError) return false;
  if (file.fetchUrl == null || file.fetchUrl === file.url) return false;
  // Integrity failures carry no status, so check the subclass before the
  // status-gated 4xx branch below (DownloadIntegrityError extends DownloadFailedError).
  if (err instanceof DownloadIntegrityError) return true;
  if (err instanceof DownloadFailedError) {
    const { status } = err;
    if (
      status != null
      && status >= 400
      && status < 500
      && status !== 408
      && status !== 429
    ) {
      return false;
    }
    return true;
  }
  return false;
}

/** Single-GET path: one streaming fetch of the whole file. */
async function downloadFileWhole(
  file: DownloadFileSpec,
  baseLoaded: number,
  ctx: FetchFileContext,
): Promise<Blob> {
  const source = file.fetchUrl ?? file.url;
  let response: Response;
  try {
    response = await ctx.fetcher(source, {
      signal: ctx.signal,
      headers: { Accept: 'application/octet-stream' },
    });
  } catch (err) {
    if (ctx.signal.aborted) throw new DownloadAbortedError(ctx.modelId);
    throw new DownloadFailedError(
      `Network error fetching ${source}: ${errorMessage(err)}`,
      { url: file.url },
    );
  }

  if (!response.ok) {
    throw new DownloadFailedError(
      `HTTP ${response.status} fetching ${source}`,
      { url: file.url, status: response.status },
    );
  }

  const blob = await streamResponseToBlob(
    response,
    baseLoaded,
    ctx.totalBytes,
    ctx.tracker,
    ctx.signal,
    ctx.modelId,
    file.url,
  );

  // Source-agnostic integrity. The proxy performs a full-GET SHA check on
  // whole-file LFS downloads, but a direct CDN fetch has no such server-side
  // guard — so verify the assembled bytes against the reviewed LFS SHA-256
  // here too, mirroring the Range-chunked path. Only LFS oids (64 hex) are
  // content SHA-256s; git-blob oids and the heuristic-fallback plan have no
  // 64-hex oid and are size-verified only (unchanged from before).
  if (file.oid?.length === 64) {
    const digest = await sha256OfBlob(blob);
    if (digest !== file.oid) {
      throw new DownloadIntegrityError(
        `SHA-256 mismatch for ${file.url}: expected ${file.oid}, got ${digest}`,
        { url: file.url },
      );
    }
  }

  return blob;
}

/**
 * Range-chunked path: pull the file in sequential `bytes=start-end` requests
 * (each retried on transient failure), then assemble the parts into one
 * disk-backed Blob via `new Blob([...])` (by-reference — no contiguous copy).
 *
 * Integrity: Range requests bypass the proxy's full-GET SHA verification, so
 * the assembled blob is size-checked against the authoritative total (from the
 * first 206 Content-Range) and, when an LFS SHA-256 oid is known, verified by
 * streaming the disk-backed blob through an incremental hasher — O(chunk)
 * memory and decoupled from per-chunk retry. A failed check throws before
 * anything is stored, so a corrupt download never stamps a cache entry.
 */
async function downloadFileInChunks(
  file: DownloadFileSpec,
  baseLoaded: number,
  ctx: FetchFileContext,
): Promise<Blob> {
  const parts: Blob[] = [];
  let received = 0;
  // Provisional total from the plan; corrected by the first 206 Content-Range
  // so a wrong heuristic estimate cannot truncate or over-run the download.
  let total = file.sizeBytes;

  while (received < total) {
    throwIfAborted(ctx.signal, ctx.modelId);
    const end = Math.min(received + ctx.rangeChunkBytes, total) - 1;
    const chunk = await fetchRangeChunk(file, received, end, baseLoaded + received, ctx);

    if (chunk.status === 200) {
      // Origin ignored Range and returned the whole file — take it as-is.
      parts.length = 0;
      parts.push(chunk.blob);
      received = chunk.blob.size;
      total = chunk.blob.size;
      break;
    }

    if (chunk.total != null) total = chunk.total;
    if (chunk.blob.size === 0) {
      throw new DownloadFailedError(
        `Empty range response for ${file.url} at offset ${received}`,
        { url: file.url },
      );
    }
    parts.push(chunk.blob);
    received += chunk.blob.size;
  }

  const assembled = new Blob(parts);
  if (assembled.size !== total) {
    throw new DownloadFailedError(
      `Incomplete download for ${file.url}: assembled ${assembled.size} of ${total} bytes`,
      { url: file.url },
    );
  }

  if (file.oid?.length === 64) {
    const digest = await sha256OfBlob(assembled);
    if (digest !== file.oid) {
      throw new DownloadIntegrityError(
        `SHA-256 mismatch for ${file.url}: expected ${file.oid}, got ${digest}`,
        { url: file.url },
      );
    }
  }

  return assembled;
}

type RangeChunk = { status: number; total: number | null; blob: Blob };

/**
 * Fetch one Range chunk, retrying transient failures. A retried attempt
 * re-requests the same byte range into a fresh Blob, so retry never corrupts
 * the assembled output. Aborts and non-retryable 4xx responses fail fast.
 */
async function fetchRangeChunk(
  file: DownloadFileSpec,
  start: number,
  end: number,
  baseLoaded: number,
  ctx: FetchFileContext,
): Promise<RangeChunk> {
  const source = file.fetchUrl ?? file.url;
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
    throwIfAborted(ctx.signal, ctx.modelId);
    try {
      let response: Response;
      try {
        response = await ctx.fetcher(source, {
          signal: ctx.signal,
          headers: {
            Accept: 'application/octet-stream',
            Range: `bytes=${start}-${end}`,
          },
        });
      } catch (err) {
        if (ctx.signal.aborted) throw new DownloadAbortedError(ctx.modelId);
        throw new DownloadFailedError(
          `Network error fetching range of ${source}: ${errorMessage(err)}`,
          { url: file.url },
        );
      }

      if (response.status !== 200 && response.status !== 206) {
        throw new DownloadFailedError(
          `HTTP ${response.status} fetching range of ${file.url}`,
          { url: file.url, status: response.status },
        );
      }

      const total = response.status === 206
        ? parseContentRangeTotal(response.headers.get('content-range'))
        : null;
      const blob = await streamResponseToBlob(
        response,
        baseLoaded,
        ctx.totalBytes,
        ctx.tracker,
        ctx.signal,
        ctx.modelId,
        file.url,
      );
      return { status: response.status, total, blob };
    } catch (err) {
      if (err instanceof DownloadAbortedError) throw err;
      if (ctx.signal.aborted) throw new DownloadAbortedError(ctx.modelId);
      // A hard 4xx (other than 408/429) won't change on retry — fail fast.
      if (
        err instanceof DownloadFailedError
        && err.status != null
        && err.status >= 400
        && err.status < 500
        && err.status !== 408
        && err.status !== 429
      ) {
        throw err;
      }
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new DownloadFailedError(`Range download failed for ${file.url}`, { url: file.url });
}

/** Parse the total size from a `Content-Range: bytes start-end/total` header. */
function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const match = /\/(\d+)\s*$/.exec(header.trim());
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : null;
}

/**
 * SHA-256 a (potentially huge, disk-backed) Blob by streaming it through an
 * incremental hasher — O(chunk) memory, never materializing the whole file.
 */
async function sha256OfBlob(blob: Blob): Promise<string> {
  const hasher = sha256.create();
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return bytesToHex(hasher.digest());
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Storage headroom preflight ─────────────────────────────────────────────

/**
 * Throw InsufficientStorageError when the origin's available budget can't hold
 * `remainingBytes` (with a small cushion). Fails open — a null/zero estimate
 * means "unknown", so the download proceeds rather than false-declining.
 */
async function assertStorageHeadroom(
  remainingBytes: number,
  estimate: () => Promise<StorageHeadroom | null>,
): Promise<void> {
  if (remainingBytes <= 0) return;
  let headroom: StorageHeadroom | null;
  try {
    headroom = await estimate();
  } catch {
    return; // probe failed — don't block on an unknown.
  }
  if (!headroom || headroom.quota <= 0) return;
  const available = headroom.quota - headroom.usage;
  if (available < remainingBytes * STORAGE_HEADROOM_FACTOR) {
    throw new InsufficientStorageError(remainingBytes, Math.max(0, available));
  }
}

/** Default headroom probe — `navigator.storage.estimate()`, or null when unavailable. */
async function defaultEstimateStorage(): Promise<StorageHeadroom | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (typeof usage !== 'number' || typeof quota !== 'number') return null;
    return { usage, quota };
  } catch {
    return null;
  }
}

/** True for a storage-quota rejection, however the platform spells it. */
function isQuotaExceeded(err: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' && err instanceof DOMException
      && (err.name === 'QuotaExceededError' || err.code === 22))
    || (err instanceof Error && err.name === 'QuotaExceededError')
  );
}
