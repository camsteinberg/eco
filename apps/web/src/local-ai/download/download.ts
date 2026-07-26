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
  partsStream,
  pickStorage,
  type Storage,
  type StorageKey,
} from './storage';
import { requestPersistentStorage } from './persistent-storage';
import { ProgressTracker, type ProgressTrackerOptions } from './progress';
import { TRANSIENT_RETRY_BASE_DELAY_MS, withTransientRetry } from './retry';
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
   * True when `sizeBytes` is a heuristic ESTIMATE (a progress/UI figure from the
   * manifest-less fallback plan), not a reviewed byte count. An estimate MUST
   * NOT be used as an integrity criterion — a file stamped with its actual bytes
   * would fail a byte-equality verify against the guess forever. Verification of
   * an estimate-sized file checks intactness instead (see `verifyPlanFile`).
   * Absent on manifest-based plans, whose sizes are exact.
   */
  sizeIsEstimate?: boolean;
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
   * Base backoff between transient re-attempts of one source (defaults to
   * TRANSIENT_RETRY_BASE_DELAY_MS). Tests use 0 so a retry path is exercised
   * without a real sleep.
   */
  retryBaseDelayMs?: number;
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
      if (!(await verifyPlanFile(storage, plan.modelId, file))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Runtime-aware "is this model downloaded and ready to serve?" — the check every
 * orchestration (the upgrade ladder, offer eligibility) must use in place of
 * `isModelFullyCached` directly.
 *
 * For most runtimes Eco's own Cache/OPFS namespace is the TERMINAL store, so
 * `isModelFullyCached` is the whole truth. A `webllm` model is the exception:
 * Eco storage is only a STAGING area — the cache bridge copies every file into
 * WebLLM's own Cache API namespaces and EMPTIES the staging cache after a
 * successful download, so an empty Eco namespace means the download SUCCEEDED.
 * There the authoritative signal is WebLLM's cache (`webllmModelInCache`),
 * reached through a lazy import so the bridge chunk stays out of eager graphs.
 * Fails closed for webllm: a bridge chunk that cannot load — or a probe that
 * throws — reads as "not downloaded", matching the fail-closed contract of the
 * check it fronts.
 */
export async function isModelDownloaded(model: ModelConfig): Promise<boolean> {
  if (model.runtime === 'webllm') {
    try {
      const { webllmModelInCache } = await import('../runtime/webllm-cache-bridge');
      return await webllmModelInCache(model);
    } catch {
      return false;
    }
  }
  return isModelFullyCached(model);
}

/**
 * The storage surface `verifyPlanFile` needs — a structural subset of `Storage`
 * so the diagnostics probe can pass its injected fake. A full `Storage`
 * satisfies it.
 */
export type PlanFileVerifier = {
  verify(key: StorageKey, expectedSizeBytes: number): Promise<boolean>;
  verifyIntact?(key: StorageKey): Promise<boolean>;
  has?(key: StorageKey): Promise<boolean>;
};

/**
 * Verify one plan file against storage under the estimate-aware rule: an
 * estimate `sizeBytes` is a progress figure, never an integrity criterion, so a
 * file flagged `sizeIsEstimate` is checked for intactness (via `verifyIntact`,
 * or mere presence when the backend lacks it) rather than byte-equality. A
 * reviewed size gets the exact byte-equality `verify`. Fails closed when an
 * estimate can't be checked at all.
 */
export async function verifyPlanFile(
  storage: PlanFileVerifier,
  modelId: string,
  file: Pick<DownloadFileSpec, 'url' | 'sizeBytes' | 'sizeIsEstimate'>,
): Promise<boolean> {
  const key = { modelId, url: file.url };
  if (file.sizeIsEstimate === true) {
    if (storage.verifyIntact) return storage.verifyIntact(key);
    if (storage.has) return storage.has(key);
    return false;
  }
  return storage.verify(key, file.sizeBytes);
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
  const retryBaseDelayMs = options?.retryBaseDelayMs ?? TRANSIENT_RETRY_BASE_DELAY_MS;
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
      const verified = await verifyPlanFile(storage, plan.modelId, file);
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
    // Net out chunk-parts already on disk for the files we're about to fetch:
    // each remaining file's preflight counts its FULL size, but a resumed file's
    // persisted parts already occupy (and are subtracted from) available space —
    // so without this a big resumable file would false-decline. Current-stamp
    // parts only; the netted figure never goes below zero.
    const persistedPartBytes = await sumPersistedPartBytes(storage, plan.modelId, remaining);
    await assertStorageHeadroom(
      Math.max(0, remainingBytes - persistedPartBytes),
      estimateStorage,
    );

    // Dev-only validation seam: only when there is something to fetch (a
    // fully-cached model has no download to fail). No-op in production.
    if (remaining.length > 0) {
      injectForcedDownloadFailure(remainingBytes);
    }

    // Second pass: fetch + store the missing files. Each fetch returns one of
    // two shapes (FetchedFile): the small single-GET path streams its body into
    // one disk-backed Blob (`kind: 'whole'`), while the chunked path persists
    // each Range chunk and returns only the part keys (`kind: 'parts'`) — never
    // an assembled Blob, so no whole file is ever materialized in the JS heap on
    // ANY engine (the zero-retention contract; see downloadFileInChunks). The
    // 'whole' path is stored with storage.put; the 'parts' path streams the
    // persisted chunks into storage.putStreamed one part at a time. storage.put
    // stamps the ACTUAL blob size and putStreamed stamps the vouched total, so
    // the size-trust contract (verify reads only Eco-Cache-Size) and the
    // heuristic-plan-size tolerance (verify catches a mismatch on the next pass)
    // are unchanged.
    const fetchContext: FetchFileContext = {
      fetcher,
      tracker,
      totalBytes,
      signal: controller.signal,
      modelId: plan.modelId,
      rangeChunkBytes,
      retryBaseDelayMs,
      storage,
      remainingBytes,
    };
    for (const file of remaining) {
      throwIfAborted(controller.signal, plan.modelId);

      const fetched = await fetchFileToBlobWithFallback(
        file,
        loadedBytes,
        fetchContext,
      );

      const identity = { modelId: plan.modelId, url: file.url };
      // Chunk-part keys to sweep after a successful whole-file store (empty on
      // the whole-file path). Declared out here so the sweep below covers both
      // kinds. Left un-swept when the parts BECOME the terminal storage.
      const partKeys = fetched.kind === 'parts' ? fetched.partKeys : [];
      // True once the parts are the file's permanent storage (finalizeParts):
      // they must NOT be swept — they ARE the bytes.
      let partsAreTerminal = false;

      if (fetched.kind === 'whole') {
        loadedBytes += fetched.blob.size;
      } else {
        loadedBytes += fetched.sizeBytes;
      }

      try {
        if (fetched.kind === 'whole') {
          await storage.put(identity, new Response(fetched.blob));
        } else if (storage.finalizeParts) {
          // Parts-native terminal store: the persisted parts ARE the file. Write
          // only a tiny manifest at the identity — never a whole-file body. This
          // is the WebKit-mobile fix: a single ~543 MB Cache-API put is not
          // survivable even streamed, and parts + a whole copy cannot fit an iOS
          // origin quota. The parts stay on disk permanently (NOT swept below).
          await storage.finalizeParts(identity, fetched.partKeys, fetched.sizeBytes);
          partsAreTerminal = true;
        } else if (storage.putStreamed) {
          // Zero-retention whole-file finalize for backends without
          // finalizeParts: stream the persisted parts straight into one entry
          // without ever assembling the file in the heap. The parts are swept
          // after the store (they were only a resume aid, not the storage).
          await storage.putStreamed(
            identity,
            partsStream(storage, plan.modelId, fetched.partKeys),
            fetched.sizeBytes,
          );
        } else {
          // Test-fake fallback: backends without putStreamed OR finalizeParts
          // (never a real backend) compose the part blobs the old way. Real
          // backends implement finalizeParts, so shipping devices never hit this.
          const parts: Blob[] = [];
          for (const key of fetched.partKeys) {
            const entry = await storage.get({ modelId: plan.modelId, url: key });
            if (!entry) {
              throw new DownloadFailedError(
                `Persisted chunk unreadable at ${key} for ${file.url}`,
                { url: file.url },
              );
            }
            parts.push(await entry.response.blob());
          }
          await storage.put(identity, new Response(new Blob(parts)));
        }
      } catch (err) {
        // A late quota failure (estimate was optimistic, or space vanished
        // mid-download) becomes the same honest storage error as the preflight.
        // The chunk-parts are deliberately NOT swept here: the final store is the
        // likeliest transient-quota moment, and retained parts let the next
        // attempt resume rather than restart. clearModel is the eventual sweep.
        if (isQuotaExceeded(err)) throw new InsufficientStorageError(remainingBytes);
        throw err;
      }
      filesFetched += 1;

      // Sweep this file's chunk-parts ONLY after a whole-file store succeeds —
      // deleting earlier would destroy the resume bytes on a failed store. Skip
      // entirely when the parts became the terminal storage (parts-native).
      if (!partsAreTerminal) {
        await deletePartsBestEffort(storage, plan.modelId, partKeys);
      }
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
  // The transport URL actually being read — used in the error message so a
  // failure names where the bytes came from (the CDN, or the proxy after a
  // fallback), not the storage identity.
  sourceUrl: string,
  // The stable storage identity — kept as the structured `url` field so callers
  // and the ledger key on it regardless of transport.
  identityUrl: string,
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
      `Network error streaming ${sourceUrl}: ${errorMessage(err)}`,
      { url: identityUrl },
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
  /** Base backoff between transient re-attempts of one source (0 in tests). */
  retryBaseDelayMs: number;
  /** Storage backend — chunked downloads persist/resume completed chunks through it. */
  storage: Storage;
  /**
   * Total bytes still to fetch across the plan. Used only to convert a
   * QuotaExceededError from a chunk-part write into the same honest
   * InsufficientStorageError the final storage.put raises.
   */
  remainingBytes: number;
};

/**
 * A fetched file, in one of two shapes the caller stores differently:
 *
 *   - `'whole'` — the single-GET path streamed the body into one disk-backed
 *     Blob; the caller stores it with `storage.put(new Response(blob))`.
 *   - `'parts'` — the chunked path left the bytes as persisted chunk-parts and
 *     never assembled them in memory (the zero-retention contract). The caller
 *     stores them by streaming the parts straight into `storage.putStreamed`,
 *     then sweeps `partKeys` AFTER that store succeeds (see the deletion-ordering
 *     note in `downloadByPlan`). `sizeBytes` is the authoritative total the
 *     store stamps as Eco-Cache-Size.
 */
type FetchedFile =
  | { kind: 'whole'; blob: Blob }
  | { kind: 'parts'; sizeBytes: number; partKeys: string[] };

// ─── Chunk-part persistence (mid-file resume) ────────────────────────────────
//
// A chunked download persists each completed 32 MiB Range chunk under its own
// storage entry so an interruption (tab close, abort, network death) resumes
// mid-file instead of restarting the ~2 GB largest weight from byte 0. Parts
// live in the model's own storage namespace under a key derived from the file
// identity, a stamp binding them to the exact expected bytes, and their byte
// offset. They are invisible to self-heal's reconcile pass (repairModelCache
// only inspects the known plan-file keys, never enumerates part keys) and are
// swept by clearModel and after a successful whole-file store.

/**
 * PATH suffix (not a query string) marking a chunk-part entry. OPFS's
 * safeFileName strips queries, so a query-based scheme would collide across
 * offsets; a path suffix survives it.
 */
const PART_MARKER = '.ecopart.';

/**
 * Stamp binding a part to the exact bytes it belongs to: the reviewed LFS
 * SHA-256 when present (a 64-hex oid, the same shape the SHA verify trusts),
 * else the declared size. A catalog/revision bump changes the stamp, so parts
 * from a superseded revision can never be stitched into the new file (the
 * full-file SHA remains the ultimate backstop).
 */
function partStamp(file: DownloadFileSpec): string {
  return file.oid?.length === 64 ? file.oid : `s${file.sizeBytes}`;
}

/** Storage key url for the part of `file` beginning at byte `offset`. */
function partKeyUrl(file: DownloadFileSpec, offset: number): string {
  return `${file.url}${PART_MARKER}${partStamp(file)}.${offset}`;
}

/** True when `url` is a chunk-part key belonging to `file` (any stamp). */
function isPartUrlFor(url: string, file: DownloadFileSpec): boolean {
  const marker = url.indexOf(PART_MARKER);
  if (marker < 0) return false;
  // `storage.listForModel` may return an absolutized url while `file.url` is a
  // relative proxy path, so match by suffix rather than equality.
  const base = url.slice(0, marker);
  return base === file.url || base.endsWith(file.url);
}

/** The stamp segment of a part key url, or null when it isn't a part key. */
function partStampOf(url: string): string | null {
  const marker = url.indexOf(PART_MARKER);
  if (marker < 0) return null;
  const tail = url.slice(marker + PART_MARKER.length);
  const dot = tail.lastIndexOf('.');
  if (dot < 0) return null;
  return tail.slice(0, dot);
}

/** The byte offset encoded in a part key url, or null when it isn't parseable. */
function partOffsetOf(url: string): number | null {
  const marker = url.indexOf(PART_MARKER);
  if (marker < 0) return null;
  const tail = url.slice(marker + PART_MARKER.length);
  const dot = tail.lastIndexOf('.');
  if (dot < 0) return null;
  const raw = tail.slice(dot + 1);
  if (!/^\d+$/.test(raw)) return null;
  const offset = Number(raw);
  return Number.isInteger(offset) && offset >= 0 ? offset : null;
}

/** Best-effort removal of part entries — failures are non-fatal. */
async function deletePartsBestEffort(
  storage: Storage,
  modelId: string,
  urls: Iterable<string>,
): Promise<void> {
  for (const url of urls) {
    try {
      await storage.remove({ modelId, url });
    } catch {
      // Non-fatal: a leftover part costs disk until clearModel, never correctness.
    }
  }
}

/** A persisted chunk-part of one file, as seen through a storage enumeration. */
type PersistedPart = { url: string; offset: number; sizeBytes: number };

/**
 * The current-stamp chunk-parts for `file` from a storage enumeration, sorted
 * by byte offset. Reads only each part's STAMPED size from the enumeration —
 * never a part's bytes. Shared by the resume walk and the preflight credit so
 * the two never diverge on which parts "belong" to the file (a stale-stamp part
 * — bound to a superseded oid/size — is excluded from both).
 */
function currentStampParts(
  entries: ReadonlyArray<{ url: string; sizeBytes: number | null }>,
  file: DownloadFileSpec,
): PersistedPart[] {
  const stamp = partStamp(file);
  const mine: PersistedPart[] = [];
  for (const entry of entries) {
    if (!isPartUrlFor(entry.url, file)) continue;
    if (partStampOf(entry.url) !== stamp) continue;
    const offset = partOffsetOf(entry.url);
    if (offset == null || entry.sizeBytes == null || entry.sizeBytes <= 0) continue;
    mine.push({ url: entry.url, offset, sizeBytes: entry.sizeBytes });
  }
  mine.sort((a, b) => a.offset - b.offset);
  return mine;
}

/**
 * Bytes contiguously present from offset 0 across `parts` (already offset-sorted).
 * A gap stops the walk — bytes past it are non-contiguous and cannot be resumed,
 * so they don't count toward what a resume already has on disk.
 */
function contiguousResumedBytes(parts: ReadonlyArray<PersistedPart>): number {
  let received = 0;
  for (const part of parts) {
    if (part.offset !== received) break;
    received += part.sizeBytes;
  }
  return received;
}

/**
 * Sum the contiguously-resumable bytes already on disk for the given files —
 * the figure the preflight nets out of `remainingBytes` so a resumable download
 * isn't false-declined (a device at 97% must not be asked for 100% headroom,
 * and a parts-native file needs only 1× the total on disk, never 2×). Only the
 * contiguous-from-zero run counts, because that is exactly what the resume walk
 * keeps; orphaned parts past a gap are swept, not resumed. Best-effort: an
 * enumeration failure returns 0 (the preflight then sees the full figure and
 * stays conservative).
 */
async function sumPersistedPartBytes(
  storage: Storage,
  modelId: string,
  files: ReadonlyArray<DownloadFileSpec>,
): Promise<number> {
  if (files.length === 0) return 0;
  let entries: { url: string; sizeBytes: number | null }[];
  try {
    entries = await storage.listForModel(modelId);
  } catch {
    return 0;
  }
  let sum = 0;
  for (const file of files) {
    sum += contiguousResumedBytes(currentStampParts(entries, file));
  }
  return sum;
}

/**
 * Fetch one file into a (disk-backed) Blob. Files above the chunk threshold
 * stream via sequential Range requests so no single request can outlive the
 * proxy function budget; smaller files keep the single-GET path (which also
 * gets the proxy's full-GET SHA verification for free).
 *
 * Transient retry sits at different granularities on the two paths: the chunked
 * path retries INSIDE `fetchRangeChunk` (one 32 MiB request at a time, so a blip
 * never re-downloads what already landed), while the single-GET path retries the
 * whole request — it is small by definition and has no chunk boundary to resume
 * from. Retrying the single-GET path here rather than in `downloadFileWhole`
 * keeps the retry an attribute of the fetch, not of the streaming code.
 */
async function fetchFileToBlob(
  file: DownloadFileSpec,
  baseLoaded: number,
  ctx: FetchFileContext,
): Promise<FetchedFile> {
  if (file.sizeBytes > ctx.rangeChunkBytes) {
    return downloadFileInChunks(file, baseLoaded, ctx);
  }
  return withDownloadRetry(() => downloadFileWhole(file, baseLoaded, ctx), ctx);
}

/**
 * Re-attempt `attempt` against the SAME transport source after a short,
 * abort-aware backoff. Both source attempts of `fetchFileToBlobWithFallback`
 * (the CDN and the proxy it falls back to) run through here, so a blip on
 * either one is absorbed before the source switch is spent.
 */
function withDownloadRetry<T>(
  attempt: () => Promise<T>,
  ctx: FetchFileContext,
): Promise<T> {
  return withTransientRetry(attempt, {
    signal: ctx.signal,
    abortError: () => new DownloadAbortedError(ctx.modelId),
    isRetryable: isRetryableTransportError,
    baseDelayMs: ctx.retryBaseDelayMs,
  });
}

/**
 * Whether an identical re-attempt against the SAME source could plausibly
 * succeed — the inner-axis counterpart to `shouldFallbackToProxy`.
 *
 * False for anything that is not a transport failure (an abort, an
 * `InsufficientStorageError`, a storage-backend write error): a different
 * moment cannot change any of those. False for a hard 4xx other than 408/429 —
 * including the 416 that a heuristic-estimate overshoot raises, whose recovery
 * is the part sweep and a fresh attempt, not a re-request of the same
 * unsatisfiable range. False for a `DownloadIntegrityError`: corrupt bytes are
 * not a blip, and re-reading the same source reproduces them — the CDN→proxy
 * source switch is that failure's recovery axis.
 *
 * True for a 5xx/408/429 and for a status-less `DownloadFailedError` (a network
 * error or a body stream that died mid-flight) — the flaky-link cases a second
 * attempt genuinely fixes.
 */
function isRetryableTransportError(err: unknown): boolean {
  if (err instanceof DownloadIntegrityError) return false;
  if (!(err instanceof DownloadFailedError)) return false;
  const { status } = err;
  if (status == null) return true;
  if (status >= 400 && status < 500) return status === 408 || status === 429;
  return true;
}

/**
 * Fetch one file, falling back from the CDN to the same-origin proxy on a
 * transport failure.
 *
 * A file's bytes are normally pulled from `file.fetchUrl` (the direct R2 CDN
 * URL when configured); `file.url` is the stable same-origin proxy path — Eco's
 * own re-emit of the HF object, which always resolves. A CDN outage OR a CDN
 * that is simply missing this artifact (an incompletely-mirrored model — the
 * proxy still re-emits it from HF) should not fail the download when the proxy
 * can still serve, so on a transport-level error (5xx/408/429/network, a CDN
 * serving corrupt bytes, or a 403/404 mirror miss) this retries ONCE against the
 * proxy by pinning `fetchUrl` to `url`.
 *
 * This is the OUTER recovery axis, distinct from the transient retry inside
 * `fetchFileToBlob`: that retries the SAME source on a blip; this switches
 * SOURCE after those retries are spent. Both source attempts carry the inner
 * retry, so a blip on the proxy fallback is absorbed too.
 * The switch is structural, not a per-chunk latch: the whole per-file fetch is
 * re-entered with the source pinned to the proxy, so EVERY subsequent chunk of
 * that file resolves to the proxy (a chunked resume adopts any parts the CDN
 * attempt persisted first). The doomed-CDN cost is bounded to the single request
 * whose failure triggers the fallback — later chunks never re-probe the CDN.
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
): Promise<FetchedFile> {
  try {
    return await fetchFileToBlob(file, baseLoaded, ctx);
  } catch (err) {
    if (!shouldFallbackToProxy(err, file, ctx.signal)) throw err;
    // Exactly one line per fallen-back file. Mirror drift (a 403/404 — the CDN
    // is missing an artifact the proxy still serves) is called out by name so it
    // is never silent; `shouldFallbackToProxy` guarantees `fetchUrl` is the
    // distinct CDN source here.
    console.warn(cdnFallbackWarning(file.fetchUrl ?? file.url, err));
    // Pin the transport source to the stable proxy identity for the retry. If
    // this attempt also fails, its error propagates normally (no third try).
    // The retry re-enters the chunked path, which resumes from any parts the
    // CDN attempt persisted before failing — a dead CDN mid-file is continued,
    // not restarted. (A corrupt-bytes CDN failure cleaned its parts before
    // throwing, so the proxy retry starts clean rather than re-stitching them.)
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
 *   - the error is a hard 4xx OTHER than 403/404: a 400/410/etc. reflects a
 *     genuinely bad request/object that the proxy won't resolve either. 408/429
 *     are transient and fall back; 403/404 are the mirror-drift signal below;
 *   - the error is non-transport (e.g. `InsufficientStorageError`): a different
 *     source can't create disk space.
 *
 * True (fall back) for a `DownloadFailedError` carrying a 5xx/408/429 status or
 * no status (a network error); for a `DownloadIntegrityError` — a CDN serving
 * corrupt bytes is worth re-fetching through the proxy, whose full-GET path
 * carries a server-side SHA guard; and for a 403/404 — an incompletely-mirrored
 * CDN is missing an artifact the same-origin proxy still re-emits from HF, so
 * the identical path DOES resolve on the proxy (this is the mirror-drift fix).
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
      && status !== 403
      && status !== 404
      && status !== 408
      && status !== 429
    ) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * One-line console warning for a CDN→proxy fallback. A 403/404 mirror miss (the
 * CDN never received this artifact) is named explicitly so drift between the
 * shipped model and its R2 mirror is always visible in the field; transient
 * (5xx/408/429), corrupt-bytes, and network failures get a plainer line.
 * `cdnUrl` is the transport source that failed — always the distinct CDN URL at
 * the call site (`shouldFallbackToProxy` returned true, which requires it).
 */
function cdnFallbackWarning(cdnUrl: string, err: unknown): string {
  const prefix = '[eco-model-cdn]';
  const status = err instanceof DownloadFailedError ? err.status : undefined;
  if (status === 403 || status === 404) {
    return `${prefix} CDN returned ${status} for ${cdnUrl} — falling back to the `
      + `same-origin proxy. The model mirror is likely missing this artifact.`;
  }
  if (err instanceof DownloadIntegrityError) {
    return `${prefix} CDN served bytes for ${cdnUrl} that failed the integrity check `
      + `— falling back to the same-origin proxy.`;
  }
  if (status != null) {
    return `${prefix} CDN returned ${status} for ${cdnUrl} — falling back to the `
      + `same-origin proxy.`;
  }
  return `${prefix} CDN fetch failed for ${cdnUrl} (${errorMessage(err)}) — falling `
    + `back to the same-origin proxy.`;
}

/** Single-GET path: one streaming fetch of the whole file. */
async function downloadFileWhole(
  file: DownloadFileSpec,
  baseLoaded: number,
  ctx: FetchFileContext,
): Promise<FetchedFile> {
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
    source,
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

  return { kind: 'whole', blob };
}

/**
 * Range-chunked path: pull the file in sequential `bytes=start-end` requests
 * (each retried on transient failure), persisting each chunk to storage as it
 * arrives and returning ONLY the ordered part keys — never an assembled Blob.
 *
 * ZERO-RETENTION CONTRACT (the WebKit-mobile kill, 2026-07-17): no code path
 * here may reference more than one chunk's bytes at any time, on any engine,
 * regardless of how that engine backs a Blob. Each fetched chunk is streamed
 * into storage and then goes out of scope with its loop iteration; the parts
 * are never read back into an in-memory array, and the whole file is never
 * assembled with `new Blob([...])`. The caller streams the persisted parts
 * straight into `storage.putStreamed` (one part open at a time), so the file's
 * bytes are never materialized in the JS heap between the wire and cache
 * storage.
 *
 * Why the earlier fixes were partial: #186 stopped the download's own
 * full-file materialization but still assembled `new Blob(parts)` from
 * network-response blobs; #35 read the parts back from storage before
 * assembling. Both trusted that a Blob handle (network- or cache-read) is
 * disk-backed rather than heap-resident — an assumption iOS Safari violates,
 * so a ~543 MB download still crossed the tab budget and crash-looped
 * mid-download. Retaining zero assembled bytes is the only design that holds
 * without that assumption.
 *
 * Integrity: Range requests bypass the proxy's full-GET SHA verification, so
 * before returning (BEFORE any whole-file store) the persisted parts are
 * size-checked against the authoritative total (from the first 206
 * Content-Range) and, when an LFS SHA-256 oid is known, hashed by streaming
 * each part through an incremental hasher one at a time — O(chunk) memory. A
 * failed check throws before anything is stored under the file identity, so a
 * corrupt download never stamps a cache entry.
 *
 * Overshoot correction: when a resume already covers the origin's real size but
 * the plan total (a heuristic estimate) is larger, the next range lands past
 * EOF and the origin answers 416 — treated as EOF evidence that corrects the
 * total from its Content-Range, not as a failure (see the 416 branch below).
 */
async function downloadFileInChunks(
  file: DownloadFileSpec,
  baseLoaded: number,
  ctx: FetchFileContext,
): Promise<FetchedFile> {
  // Storage keys of the persisted parts, in byte order. This is the ONLY thing
  // the loop accumulates — no `parts: Blob[]`, so no chunk's bytes outlive its
  // iteration. Returned to the caller for the streamed store and post-store
  // sweep, and used for integrity/failure cleanup.
  const partKeys: string[] = [];
  let received = 0;
  // Provisional total from the plan; corrected by the first 206 Content-Range
  // so a wrong heuristic estimate cannot truncate or over-run the download.
  let total = file.sizeBytes;
  // The transport being read this pass (the CDN, or the proxy after a fallback
  // pinned `fetchUrl` to `url`). Used in error messages so a failure names where
  // the range request went, while the storage identity stays `file.url`.
  const source = file.fetchUrl ?? file.url;

  // Resume: adopt any previously-persisted contiguous parts for this file's
  // current stamp, and sweep stale (superseded-revision) or non-contiguous ones.
  received = await resumeFromPersistedParts(file, ctx, partKeys);
  if (received > 0) {
    // Seed the bar to the resumed offset once. The tracker is absolute and
    // clamped, so this neither double-counts nor regresses a later sample.
    ctx.tracker.reportDownloadProgress(baseLoaded + received, ctx.totalBytes);
  }

  // When every part is already present (received >= total) the while loop is
  // skipped and we fall straight through to the integrity pass — this covers an
  // interrupt between the last chunk write and the final whole-file store.
  while (received < total) {
    throwIfAborted(ctx.signal, ctx.modelId);
    const end = Math.min(received + ctx.rangeChunkBytes, total) - 1;
    const chunk = await fetchRangeChunk(file, received, end, baseLoaded + received, ctx);

    if (chunk.status === 416) {
      // The requested range starts at/after the origin's real EOF — the plan's
      // total overshot the origin's real size (heuristic-estimate plans carry no
      // reviewed byte count), so a resume that already covers the real file asks
      // for bytes that don't exist. The 416's Content-Range total is the
      // authoritative correction: adopt it and let the received===total guard
      // below adjudicate. When the resumed parts exactly cover that real total
      // the download completes from them (the self-heal path for a wedged
      // device); otherwise the guard sweeps and throws.
      if (chunk.total != null) {
        total = chunk.total;
        break;
      }
      // No Content-Range to correct the total by, and the resumed parts can't be
      // trusted to cover the real file — clear them so a retry starts clean
      // rather than re-requesting the same unsatisfiable range forever.
      await deletePartsBestEffort(ctx.storage, ctx.modelId, partKeys);
      throw new DownloadFailedError(
        `Range request for ${source} was unsatisfiable (HTTP 416) with no Content-Range; `
        + `cleared ${partKeys.length} resumed part(s) for a clean retry`,
        { url: file.url, status: 416 },
      );
    }

    if (chunk.status === 200) {
      // Origin ignored Range and returned the whole file — persist it as a
      // single part. The resumed parts are abandoned here but remain in storage;
      // their keys stay in partKeys so the caller still sweeps them after the
      // whole-file store. The chunk blob is not read back — its bytes drop with
      // this iteration.
      const wholeKey = partKeyUrl(file, 0);
      try {
        await ctx.storage.put(
          { modelId: ctx.modelId, url: wholeKey },
          new Response(chunk.blob),
        );
      } catch (err) {
        if (isQuotaExceeded(err)) throw new InsufficientStorageError(ctx.remainingBytes);
        throw err;
      }
      partKeys.push(wholeKey);
      received = chunk.blob.size;
      total = chunk.blob.size;
      break;
    }

    if (chunk.total != null) total = chunk.total;
    if (chunk.blob.size === 0) {
      throw new DownloadFailedError(
        `Empty range response for ${source} at offset ${received}`,
        { url: file.url },
      );
    }

    // Persist the validated chunk BEFORE advancing so an interruption resumes
    // from this boundary. A quota failure here surfaces as the same honest
    // InsufficientStorageError the final store raises.
    const key = partKeyUrl(file, received);
    try {
      await ctx.storage.put(
        { modelId: ctx.modelId, url: key },
        new Response(chunk.blob),
      );
    } catch (err) {
      if (isQuotaExceeded(err)) throw new InsufficientStorageError(ctx.remainingBytes);
      throw err;
    }
    partKeys.push(key);
    received += chunk.blob.size;
  }

  if (received !== total) {
    // Persisted parts are inconsistent with the authoritative total — clean
    // them so a resumed attempt (or the L2 proxy fallback) starts fresh rather
    // than re-stitching the same bad bytes forever.
    await deletePartsBestEffort(ctx.storage, ctx.modelId, partKeys);
    throw new DownloadFailedError(
      `Incomplete download for ${file.url}: received ${received} of ${total} bytes`,
      { url: file.url },
    );
  }

  if (file.oid?.length === 64) {
    // Hash the persisted parts one at a time — never materialize the whole
    // file. Each part is streamed (its own body, or its blob's stream as a
    // fallback) through the incremental hasher, so peak memory stays O(chunk).
    const hasher = sha256.create();
    for (const key of partKeys) {
      const entry = await ctx.storage.get({ modelId: ctx.modelId, url: key });
      if (!entry) {
        await deletePartsBestEffort(ctx.storage, ctx.modelId, partKeys);
        throw new DownloadFailedError(
          `Persisted chunk unreadable at ${key} for ${file.url}`,
          { url: file.url },
        );
      }
      const body = entry.response.body ?? (await entry.response.blob()).stream();
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hasher.update(value);
      }
    }
    const digest = bytesToHex(hasher.digest());
    if (digest !== file.oid) {
      // Corrupt persisted bytes — never trust a resume over them. Clean before
      // throwing so the fallback/retry re-downloads instead of re-failing.
      await deletePartsBestEffort(ctx.storage, ctx.modelId, partKeys);
      throw new DownloadIntegrityError(
        `SHA-256 mismatch for ${file.url}: expected ${file.oid}, got ${digest}`,
        { url: file.url },
      );
    }
  }

  return { kind: 'parts', sizeBytes: total, partKeys };
}

/**
 * Adopt previously-persisted chunk-parts for `file` so a resumed download
 * continues mid-file. Enumerates the model namespace, walks the current-stamp
 * parts contiguously from offset 0 into `partKeys`, and best-effort sweeps
 * stale-stamp parts and any non-contiguous leftovers beyond the walk. Returns
 * the resumed byte count (0 when nothing usable is present).
 *
 * Zero-retention: the walk confirms each part exists and reads its stamped size
 * from the enumeration — it never reads a part's BYTES. The bytes are streamed
 * only later, one at a time, by the integrity pass and the streamed store.
 */
async function resumeFromPersistedParts(
  file: DownloadFileSpec,
  ctx: FetchFileContext,
  partKeys: string[],
): Promise<number> {
  let entries: { url: string; sizeBytes: number | null }[];
  try {
    entries = await ctx.storage.listForModel(ctx.modelId);
  } catch {
    return 0; // Enumeration failed — treat as a cold start.
  }

  const stamp = partStamp(file);
  // Stale = this file's part urls bound to a SUPERSEDED stamp (a different
  // oid/size) — they can never stitch into the current file and are swept.
  // The current-stamp parts (offset-sorted) come from the shared selector so
  // the preflight credit and this walk agree on what "belongs" to the file.
  const stale: string[] = [];
  for (const entry of entries) {
    if (isPartUrlFor(entry.url, file) && partStampOf(entry.url) !== stamp) {
      stale.push(entry.url);
    }
  }
  const mine = currentStampParts(entries, file);

  let received = 0;
  const walked = new Set<string>();
  for (const part of mine) {
    if (part.offset !== received) break; // Gap: the rest is non-contiguous.
    const key = partKeyUrl(file, received);
    let present: boolean;
    try {
      present = await ctx.storage.has({ modelId: ctx.modelId, url: key });
    } catch {
      present = false;
    }
    if (!present) break; // Missing bytes for a supposedly-present part — stop.
    partKeys.push(key);
    walked.add(part.url);
    received += part.sizeBytes;
  }

  // Everything not consumed by the contiguous walk (past a gap, or after an
  // unreadable part) is unusable — sweep it along with the stale-stamp set.
  const orphans = mine.filter((p) => !walked.has(p.url)).map((p) => p.url);
  await deletePartsBestEffort(ctx.storage, ctx.modelId, [...stale, ...orphans]);

  return received;
}

type RangeChunk = { status: number; total: number | null; blob: Blob };

/**
 * Fetch one Range chunk, retrying transient failures against the same source
 * with a backoff. A retried attempt re-requests the same byte range into a
 * fresh Blob, so retry never corrupts the assembled output. Aborts and
 * non-retryable 4xx responses fail fast (see `isRetryableTransportError`).
 */
function fetchRangeChunk(
  file: DownloadFileSpec,
  start: number,
  end: number,
  baseLoaded: number,
  ctx: FetchFileContext,
): Promise<RangeChunk> {
  return withDownloadRetry(
    () => fetchRangeChunkOnce(file, start, end, baseLoaded, ctx),
    ctx,
  );
}

/** One Range request — the retryable unit. */
async function fetchRangeChunkOnce(
  file: DownloadFileSpec,
  start: number,
  end: number,
  baseLoaded: number,
  ctx: FetchFileContext,
): Promise<RangeChunk> {
  const source = file.fetchUrl ?? file.url;
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

  if (response.status === 416) {
    // Range Not Satisfiable is EOF evidence, not a failure: the requested
    // start lies at/after the origin's real size. Return it as a chunk
    // signal (an empty blob, NOT streamed) carrying the Content-Range total
    // — the caller uses that to correct an overshooting plan estimate. See
    // the 416 branch in downloadFileInChunks.
    return {
      status: 416,
      total: parseContentRangeTotal(response.headers.get('content-range')),
      blob: new Blob([]),
    };
  }
  if (response.status !== 200 && response.status !== 206) {
    throw new DownloadFailedError(
      `HTTP ${response.status} fetching range of ${source}`,
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
    source,
    file.url,
  );
  return { status: response.status, total, blob };
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
