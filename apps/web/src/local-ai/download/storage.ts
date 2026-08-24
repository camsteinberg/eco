// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Storage — OPFS + Cache API abstraction.
 *
 * Contract guarantees that close the legacy size-trust bug class:
 *
 *   - put() ALWAYS writes Eco-Cache-Size on the cached entry. The byte
 *     count comes from the body that's actually stored, not from any
 *     header on the incoming response (CDNs like the HuggingFace mirrors
 *     strip `content-length` on chunked transfer, which the old path
 *     relied on as a fallback).
 *
 *   - verify() reads Eco-Cache-Size ONLY. No content-length fallback.
 *     If the header is missing the entry is treated as "unverified" —
 *     the caller decides whether to refresh or clean.
 *
 *   - countCached() returns the number of files that pass verify(). It
 *     never calls remove(). cleanCorrupted() is the single explicit
 *     cleanup path — counting and cleanup are deliberately decoupled so
 *     a count miss does not wipe resumable bytes.
 *
 * The legacy header name (`x-eco-cache-size-bytes`) is preserved so that
 * entries written by the old code path are readable by the new code
 * path (and vice versa).
 *
 * OPFS support: the OpfsStorage backend exists for model weights on
 * browsers where OPFS is available (Chrome 102+, Safari 26+,
 * Firefox 117+). Jsdom does not implement OPFS; its unit-test coverage
 * is intentionally lighter than CacheApiStorage's. The Playwright pass
 * exercises OPFS end-to-end.
 */

import type { ModelConfig } from '../types';

export const ECO_CACHE_SIZE_HEADER = 'x-eco-cache-size-bytes';

/**
 * Marks a cache entry as a PARTS-NATIVE manifest: the identity key holds no
 * whole-file body, and the file's bytes live permanently as its chunk-parts
 * (see `finalizeParts`). Presence flags parts-native; the value is the part
 * count (informational). The ordered part-key list lives in the manifest BODY
 * (small JSON) rather than a header — a ~2 GB weight has ~64 part keys, which
 * would push a header past its length limits on some engines, so the body is
 * the safe home for the list.
 */
export const ECO_PARTS_NATIVE_HEADER = 'x-eco-parts-native';

/**
 * URL marker for chunk-part entries: `<fileUrl>.ecopart.<stamp>.<offset>`.
 * Part of the cache format contract (like the two headers above) — storage
 * accounting uses it to recognise that a part entry's bytes are already
 * covered by its completed manifest's stamped aggregate.
 */
export const ECO_PART_MARKER = '.ecopart.';

/**
 * A listed chunk-part was gone while composing a parts-native read. Thrown into
 * the composition stream so the consumer's existing corrupted-entry handling
 * (re-download) fires. Defined here (not imported from download.ts) so storage
 * stays free of a download → storage → download import cycle; a plain Error
 * subclass matches this module's existing error style.
 */
export class StoragePartMissingError extends Error {
  readonly partKey: string;
  constructor(partKey: string) {
    super(`Persisted chunk-part is missing: ${partKey}`);
    this.name = 'StoragePartMissingError';
    this.partKey = partKey;
  }
}

export type StorageKey = {
  modelId: string;
  url: string;
};

export type CachedEntry = {
  response: Response;
  sizeBytes: number;
};

export type FileSpec = {
  url: string;
  sizeBytes: number;
};

export type StorageBackendName = 'opfs' | 'cache-api';

export interface Storage {
  readonly backend: StorageBackendName;
  put(key: StorageKey, response: Response): Promise<void>;
  /**
   * Stream a body of KNOWN size directly into storage without ever
   * materializing it (put() must read the whole body to stamp its size —
   * an engine-defined memory cost for large composites). The caller vouches
   * for sizeBytes; it is stamped as Eco-Cache-Size verbatim. Optional so
   * test fakes stay minimal — callers must fall back to put().
   */
  putStreamed?(key: StorageKey, body: ReadableStream<Uint8Array>, sizeBytes: number): Promise<void>;
  /**
   * Declare a chunked file COMPLETE with its parts as the terminal storage —
   * no whole-file entry is ever written (a single huge put is not survivable
   * on WebKit, and doubling the bytes cannot fit an iOS origin quota). Writes
   * a zero-length manifest at the identity key carrying the aggregate size,
   * so verify()/get() serve the file transparently: verify reads the stamped
   * total; get composes the parts as a pull-based stream, one part open at a
   * time. Optional: backends without it keep the whole-file finalize.
   */
  finalizeParts?(key: StorageKey, partKeys: readonly string[], sizeBytes: number): Promise<void>;
  get(key: StorageKey): Promise<CachedEntry | null>;
  has(key: StorageKey): Promise<boolean>;
  verify(key: StorageKey, expectedSizeBytes: number): Promise<boolean>;
  /**
   * Exactly `verify` minus the expected-size equality: the entry exists with a
   * readable stamped size and — when parts-native — every listed part still
   * exists. This is the integrity check for a file whose expected size is only
   * an ESTIMATE (a heuristic-fallback plan): the stamped bytes are the truth,
   * so gating on byte-equality against a guess would declare a healthy file
   * corrupt forever. Optional so test fakes stay minimal — callers fall back to
   * `has` when it is absent.
   */
  verifyIntact?(key: StorageKey): Promise<boolean>;
  remove(key: StorageKey): Promise<void>;
  /**
   * True when `key` resolves to a parts-native manifest (its bytes live as
   * chunk-parts, not a whole-file body). Lets a whole-file writer (e.g. the TJS
   * cache bridge's put) refuse to clobber a manifest with a huge whole-body
   * entry — the exact write parts-native exists to avoid. Optional: absent on
   * backends that never write manifests (a missing method reads as "not
   * parts-native").
   */
  isPartsNative?(key: StorageKey): Promise<boolean>;
  listForModel(modelId: string): Promise<{ url: string; sizeBytes: number | null }[]>;
  clearModel(modelId: string): Promise<void>;
  /**
   * Enumerate Eco's per-model Cache API namespace names (`eco-local-ai-<id>`).
   * A boot-time sweep uses it to find model caches the catalog can no longer
   * offer. Optional: backends with no namespace catalog (OPFS) omit it.
   */
  listModelCacheNames?(): Promise<string[]>;
  /**
   * Remove orphaned chunk-parts for a model — `.ecopart.` entries that NO
   * parts-native manifest claims (abandoned/interrupted resume bytes). Terminal
   * parts-native parts (their base identity carries a parts-native manifest) are
   * KEPT. Returns the count removed; no-ops when the model has no namespace.
   * Optional: backends without parts-native manifests (OPFS) omit it.
   */
  sweepOrphanedParts?(modelId: string): Promise<number>;
}

/**
 * Compose persisted chunk-parts into a single readable stream — pull-based, so
 * a consumer (`cache.put`, or a caller draining it) paces the reads and only
 * ONE part is open at a time (the zero-retention contract extended to reads).
 * A missing part mid-stream errors the stream rather than silently truncating.
 *
 * Lives here (not in download.ts) so both the download orchestrator's streamed
 * store and CacheApiStorage's parts-native `get` compose parts through ONE
 * implementation, and storage.ts never imports download.ts.
 */
export function partsStream(
  storage: Storage,
  modelId: string,
  partKeys: readonly string[],
): ReadableStream<Uint8Array> {
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          if (index >= partKeys.length) {
            controller.close();
            return;
          }
          const entry = await storage.get({ modelId, url: partKeys[index]! });
          if (!entry) {
            controller.error(new StoragePartMissingError(partKeys[index]!));
            return;
          }
          const body = entry.response.body ?? (await entry.response.blob()).stream();
          reader = body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          index += 1;
          continue;
        }
        controller.enqueue(value);
        return;
      }
    },
    cancel() {
      void reader?.cancel();
    },
  });
}

// ─── Cache API backend (primary, unit-tested) ────────────────────────────────

/**
 * Minimal CacheStorage surface — exists so tests can inject an in-memory
 * fake without touching `globalThis.caches`. The real browser type
 * `CacheStorage` is a subtype.
 */
export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  has(name: string): Promise<boolean>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

export interface CacheLike {
  put(request: RequestInfo | URL, response: Response): Promise<void>;
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  keys(): Promise<readonly Request[]>;
  delete(request: RequestInfo | URL): Promise<boolean>;
}

const CACHE_NAME_PREFIX = 'eco-local-ai-';

export class CacheApiStorage implements Storage {
  readonly backend: StorageBackendName = 'cache-api';
  private readonly cacheStorage: CacheStorageLike;

  constructor(cacheStorage?: CacheStorageLike) {
    if (cacheStorage) {
      this.cacheStorage = cacheStorage;
      return;
    }
    if (typeof caches === 'undefined') {
      throw new Error(
        'CacheApiStorage: globalThis.caches is unavailable. Pass a CacheStorageLike to the constructor.',
      );
    }
    this.cacheStorage = caches as unknown as CacheStorageLike;
  }

  async put(key: StorageKey, response: Response): Promise<void> {
    const cache = await this.cacheStorage.open(cacheNameFor(key.modelId));
    const stamped = await stampCacheSize(response);
    await cache.put(key.url, stamped);
  }

  async putStreamed(
    key: StorageKey,
    body: ReadableStream<Uint8Array>,
    sizeBytes: number,
  ): Promise<void> {
    // cache.put consumes the stream itself — the browser streams the body into
    // cache storage, so the web process only ever holds the in-flight enqueued
    // chunks. Size is stamped from the caller's vouched figure rather than by
    // reading the body (which is exactly the materialization put() pays and
    // this path exists to avoid).
    const cache = await this.cacheStorage.open(cacheNameFor(key.modelId));
    const headers = new Headers();
    headers.set(ECO_CACHE_SIZE_HEADER, String(sizeBytes));
    await cache.put(key.url, new Response(body, { headers }));
  }

  async finalizeParts(
    key: StorageKey,
    partKeys: readonly string[],
    sizeBytes: number,
  ): Promise<void> {
    // The parts already exist as their own cache entries (written chunk-by-chunk
    // during download). This writes ONLY a tiny manifest at the identity key —
    // never a whole-file body — so no put here ever exceeds one chunk's bytes.
    // The stamped Eco-Cache-Size is the aggregate total, so every existing
    // size/verify read of the identity sees the true file size; the ordered part
    // keys ride in the body for get() to compose without re-deriving ordering.
    const cache = await this.cacheStorage.open(cacheNameFor(key.modelId));
    const headers = new Headers();
    headers.set(ECO_CACHE_SIZE_HEADER, String(sizeBytes));
    headers.set(ECO_PARTS_NATIVE_HEADER, String(partKeys.length));
    const manifest = JSON.stringify({ partKeys: [...partKeys] });
    await cache.put(key.url, new Response(manifest, { headers }));
  }

  async get(key: StorageKey): Promise<CachedEntry | null> {
    const cache = await this.cacheStorage.open(cacheNameFor(key.modelId));
    const cached = await cache.match(key.url);
    if (!cached) return null;
    const sizeBytes = readCacheSize(cached);
    if (sizeBytes == null) return null;
    if (cached.headers.get(ECO_PARTS_NATIVE_HEADER) == null) {
      // Plain whole-file entry — the body IS the file.
      return { response: cached, sizeBytes };
    }
    // Parts-native: the manifest body has no file bytes. Compose the parts into
    // a streamed Response carrying the aggregate size, so the consumer reads the
    // whole file transparently (one part open at a time). An empty part list is
    // a corrupt manifest — treat as missing so the caller re-downloads.
    const partKeys = await readManifestPartKeys(cached);
    if (partKeys.length === 0) return null;
    const composed = new Response(partsStream(this, key.modelId, partKeys), {
      headers: { [ECO_CACHE_SIZE_HEADER]: String(sizeBytes) },
    });
    return { response: composed, sizeBytes };
  }

  async has(key: StorageKey): Promise<boolean> {
    const cache = await this.cacheStorage.open(cacheNameFor(key.modelId));
    const cached = await cache.match(key.url);
    return cached != null;
  }

  async isPartsNative(key: StorageKey): Promise<boolean> {
    const cache = await this.cacheStorage.open(cacheNameFor(key.modelId));
    const cached = await cache.match(key.url);
    return cached != null && cached.headers.get(ECO_PARTS_NATIVE_HEADER) != null;
  }

  async verify(key: StorageKey, expectedSizeBytes: number): Promise<boolean> {
    return this.verifyCore(key, (stampedSize) => stampedSize === expectedSizeBytes);
  }

  async verifyIntact(key: StorageKey): Promise<boolean> {
    // Same integrity gate as verify() with the size predicate relaxed — the
    // stamped size need only be readable, not equal to a caller's figure.
    return this.verifyCore(key, () => true);
  }

  /**
   * Shared verify core: the entry exists with a readable stamped size that
   * satisfies `sizeMatches`, and — when parts-native — every listed part still
   * exists (existence only, O(parts), no byte reads) so a manifest whose parts
   * were swept out from under it doesn't verify. verify() and verifyIntact()
   * differ ONLY in the size predicate.
   */
  private async verifyCore(
    key: StorageKey,
    sizeMatches: (stampedSize: number) => boolean,
  ): Promise<boolean> {
    const cache = await this.cacheStorage.open(cacheNameFor(key.modelId));
    const cached = await cache.match(key.url);
    if (!cached) return false;
    const sizeBytes = readCacheSize(cached);
    if (sizeBytes == null || !sizeMatches(sizeBytes)) return false;
    if (cached.headers.get(ECO_PARTS_NATIVE_HEADER) == null) return true;
    const partKeys = await readManifestPartKeys(cached);
    if (partKeys.length === 0) return false;
    for (const partKey of partKeys) {
      const part = await cache.match(partKey);
      if (part == null) return false;
    }
    return true;
  }

  async remove(key: StorageKey): Promise<void> {
    const cache = await this.cacheStorage.open(cacheNameFor(key.modelId));
    // A parts-native manifest owns its parts — delete them too, or removing the
    // identity would orphan hundreds of MB of chunk entries.
    const cached = await cache.match(key.url);
    if (cached != null && cached.headers.get(ECO_PARTS_NATIVE_HEADER) != null) {
      const partKeys = await readManifestPartKeys(cached);
      for (const partKey of partKeys) {
        await cache.delete(partKey).catch(() => false);
      }
    }
    await cache.delete(key.url).catch(() => false);
  }

  async listForModel(
    modelId: string,
  ): Promise<{ url: string; sizeBytes: number | null }[]> {
    const cache = await this.cacheStorage.open(cacheNameFor(modelId));
    const requests = await cache.keys();
    const out: { url: string; sizeBytes: number | null }[] = [];
    for (const request of requests) {
      const cached = await cache.match(request);
      out.push({
        url: request.url,
        sizeBytes: cached ? readCacheSize(cached) : null,
      });
    }
    return out;
  }

  async clearModel(modelId: string): Promise<void> {
    await this.cacheStorage.delete(cacheNameFor(modelId)).catch(() => false);
  }

  async listModelCacheNames(): Promise<string[]> {
    const names = await this.cacheStorage.keys();
    return names.filter(isModelCacheName);
  }

  async sweepOrphanedParts(modelId: string): Promise<number> {
    const cacheName = cacheNameFor(modelId);
    // Never CREATE a namespace: cacheStorage.open would materialize an empty
    // cache for a model that has none. A model with no bytes has no parts.
    if (!(await this.cacheStorage.has(cacheName))) return 0;
    const cache = await this.cacheStorage.open(cacheName);
    const requests = await cache.keys();
    // Base identities that carry a parts-native manifest — their chunk-parts ARE
    // the file's terminal bytes and must be kept. Enumerated from the SAME
    // keys() call as the parts below, so both share one url form (no
    // relative/absolute skew to reconcile).
    const manifestBases = new Set<string>();
    for (const request of requests) {
      if (request.url.includes(ECO_PART_MARKER)) continue;
      const cached = await cache.match(request);
      if (cached != null && cached.headers.get(ECO_PARTS_NATIVE_HEADER) != null) {
        manifestBases.add(request.url);
      }
    }
    let removed = 0;
    for (const request of requests) {
      const marker = request.url.indexOf(ECO_PART_MARKER);
      if (marker < 0) continue;
      // A part's base identity is its url up to the marker. If a parts-native
      // manifest lives there, this part is terminal storage — keep it. Otherwise
      // no live file claims these bytes: an interrupted/abandoned resume part.
      if (manifestBases.has(request.url.slice(0, marker))) continue;
      if (await cache.delete(request).catch(() => false)) removed += 1;
    }
    return removed;
  }
}

// ─── OPFS backend (used for weights; integration-tested only) ───────────────

/**
 * Minimal OPFS surface — same shape as the browser's FileSystemDirectoryHandle.
 * Jsdom does not implement OPFS, so unit coverage relies on the CacheApi
 * backend's contract test. The OPFS path is exercised by the Playwright
 * pass against a real browser.
 */
export interface OpfsRoot {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsDirHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface OpfsDirHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterable<{ name: string; kind: 'file' | 'directory' }>;
}

export interface OpfsFileHandle {
  createWritable(): Promise<OpfsWritable>;
  getFile(): Promise<File>;
}

export interface OpfsWritable {
  write(data: Blob | ArrayBuffer | Uint8Array): Promise<void>;
  close(): Promise<void>;
}

const OPFS_SIZE_SUFFIX = '.size';

export class OpfsStorage implements Storage {
  readonly backend: StorageBackendName = 'opfs';
  private readonly rootPromise: Promise<OpfsRoot>;

  constructor(rootOrFactory?: OpfsRoot | (() => Promise<OpfsRoot>)) {
    if (typeof rootOrFactory === 'function') {
      this.rootPromise = rootOrFactory();
    } else if (rootOrFactory) {
      this.rootPromise = Promise.resolve(rootOrFactory);
    } else if (
      typeof navigator !== 'undefined'
      && typeof (navigator.storage as StorageManager & { getDirectory?: () => Promise<unknown> })?.getDirectory === 'function'
    ) {
      this.rootPromise = (navigator.storage as StorageManager & { getDirectory: () => Promise<unknown> })
        .getDirectory()
        .then((value) => value as unknown as OpfsRoot);
    } else {
      throw new Error(
        'OpfsStorage: navigator.storage.getDirectory is unavailable. Pass an OpfsRoot to the constructor.',
      );
    }
  }

  async put(key: StorageKey, response: Response): Promise<void> {
    const dir = await this.modelDir(key.modelId, true);
    if (!dir) {
      throw new Error(`OpfsStorage.put: failed to open or create directory for modelId=${key.modelId}`);
    }
    const blob = await response.blob();
    const sizeBytes = blob.size;

    const fileName = safeFileName(key.url);
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();

    const sizeHandle = await dir.getFileHandle(fileName + OPFS_SIZE_SUFFIX, { create: true });
    const sizeWritable = await sizeHandle.createWritable();
    await sizeWritable.write(new TextEncoder().encode(String(sizeBytes)));
    await sizeWritable.close();
  }

  async get(key: StorageKey): Promise<CachedEntry | null> {
    const dir = await this.modelDir(key.modelId, false);
    if (!dir) return null;
    const fileName = safeFileName(key.url);
    let file: File;
    try {
      const handle = await dir.getFileHandle(fileName);
      file = await handle.getFile();
    } catch {
      return null;
    }
    const sizeBytes = await this.readSize(dir, fileName);
    if (sizeBytes == null) return null;
    const response = new Response(file, {
      headers: { [ECO_CACHE_SIZE_HEADER]: String(sizeBytes) },
    });
    return { response, sizeBytes };
  }

  async has(key: StorageKey): Promise<boolean> {
    const dir = await this.modelDir(key.modelId, false);
    if (!dir) return false;
    try {
      await dir.getFileHandle(safeFileName(key.url));
      return true;
    } catch {
      return false;
    }
  }

  async verify(key: StorageKey, expectedSizeBytes: number): Promise<boolean> {
    return this.verifyCore(key, (stampedSize) => stampedSize === expectedSizeBytes);
  }

  async verifyIntact(key: StorageKey): Promise<boolean> {
    // Same as verify() minus the size equality — the entry need only exist with
    // a readable stamped size (OPFS has no parts-native manifests).
    return this.verifyCore(key, () => true);
  }

  private async verifyCore(
    key: StorageKey,
    sizeMatches: (stampedSize: number) => boolean,
  ): Promise<boolean> {
    const entry = await this.get(key);
    if (!entry) return false;
    return sizeMatches(entry.sizeBytes);
  }

  async remove(key: StorageKey): Promise<void> {
    const dir = await this.modelDir(key.modelId, false);
    if (!dir) return;
    const fileName = safeFileName(key.url);
    await dir.removeEntry(fileName).catch(() => undefined);
    await dir.removeEntry(fileName + OPFS_SIZE_SUFFIX).catch(() => undefined);
  }

  async listForModel(
    modelId: string,
  ): Promise<{ url: string; sizeBytes: number | null }[]> {
    const dir = await this.modelDir(modelId, false);
    if (!dir) return [];
    const out: { url: string; sizeBytes: number | null }[] = [];
    for await (const entry of dir.values()) {
      if (entry.kind !== 'file') continue;
      if (entry.name.endsWith(OPFS_SIZE_SUFFIX)) continue;
      const sizeBytes = await this.readSize(dir, entry.name);
      out.push({ url: entry.name, sizeBytes });
    }
    return out;
  }

  async clearModel(modelId: string): Promise<void> {
    const root = await this.rootPromise;
    await root.removeEntry(modelDirName(modelId), { recursive: true }).catch(() => undefined);
  }

  private async modelDir(modelId: string, create: boolean): Promise<OpfsDirHandle | null> {
    const root = await this.rootPromise;
    try {
      return await root.getDirectoryHandle(modelDirName(modelId), { create });
    } catch {
      return null;
    }
  }

  private async readSize(dir: OpfsDirHandle, fileName: string): Promise<number | null> {
    try {
      const handle = await dir.getFileHandle(fileName + OPFS_SIZE_SUFFIX);
      const file = await handle.getFile();
      const text = await fileToText(file);
      const parsed = Number.parseInt(text.trim(), 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    } catch {
      return null;
    }
  }
}

// ─── Public ops (operate on whichever Storage the caller chose) ──────────────

/**
 * Count cached files for a model. Iterates each spec and tests verify().
 * NEVER deletes on mismatch — counting and cleanup are deliberately
 * decoupled. Pass the result of `verify()` for each spec into the
 * download preflight; if the count is lower than expected,
 * `cleanCorrupted` or `remove` is the explicit next step.
 */
export async function countCached(
  storage: Storage,
  modelId: string,
  files: ReadonlyArray<FileSpec>,
): Promise<number> {
  let count = 0;
  for (const file of files) {
    const verified = await storage.verify({ modelId, url: file.url }, file.sizeBytes);
    if (verified) count++;
  }
  return count;
}

/**
 * Remove entries that fail verify(). Explicit, separate from countCached.
 * Returns the number of entries removed.
 */
export async function cleanCorrupted(
  storage: Storage,
  modelId: string,
  files: ReadonlyArray<FileSpec>,
): Promise<number> {
  let removed = 0;
  for (const file of files) {
    const verified = await storage.verify({ modelId, url: file.url }, file.sizeBytes);
    if (verified) continue;
    const exists = await storage.has({ modelId, url: file.url });
    if (!exists) continue;
    await storage.remove({ modelId, url: file.url });
    removed++;
  }
  return removed;
}

export async function clearModel(storage: Storage, model: ModelConfig | string): Promise<void> {
  const modelId = typeof model === 'string' ? model : model.id;
  await storage.clearModel(modelId);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function pickStorage(opts?: {
  preferOpfs?: boolean;
  opfsRoot?: OpfsRoot | (() => Promise<OpfsRoot>);
  cacheStorage?: CacheStorageLike;
}): Storage {
  const preferOpfs = opts?.preferOpfs ?? false;
  if (preferOpfs && supportsOpfs()) {
    return new OpfsStorage(opts?.opfsRoot);
  }
  return new CacheApiStorage(opts?.cacheStorage);
}

function supportsOpfs(): boolean {
  if (typeof navigator === 'undefined') return false;
  const sm = navigator.storage as StorageManager & { getDirectory?: () => Promise<unknown> } | undefined;
  return typeof sm?.getDirectory === 'function';
}

async function stampCacheSize(response: Response): Promise<Response> {
  // Read the body. Re-emit a new Response with the byte-count tagged.
  const blob = await response.blob();
  const sizeBytes = blob.size;
  const headers = new Headers(response.headers);
  headers.set(ECO_CACHE_SIZE_HEADER, String(sizeBytes));
  return new Response(blob, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function readCacheSize(response: Response): number | null {
  const raw = response.headers.get(ECO_CACHE_SIZE_HEADER);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Read the ordered part-key list from a parts-native manifest's JSON body.
 * Consumes the response body, so callers pass a fresh `cache.match` result.
 * A malformed body yields an empty list — the callers treat that as a corrupt
 * manifest (get → missing, verify → false).
 */
async function readManifestPartKeys(manifest: Response): Promise<string[]> {
  try {
    const parsed = (await manifest.json()) as { partKeys?: unknown };
    if (
      Array.isArray(parsed.partKeys)
      && parsed.partKeys.every((k): k is string => typeof k === 'string')
    ) {
      return parsed.partKeys;
    }
  } catch {
    // Fall through — an unreadable/mis-shaped manifest reads as no parts.
  }
  return [];
}

function cacheNameFor(modelId: string): string {
  return CACHE_NAME_PREFIX + sanitizeModelId(modelId);
}

/**
 * The Cache API namespace name for a model's weights (the `eco-local-ai-<id>`
 * bucket that put/verify/clearModel all key on). Exposed so a boot-time sweep
 * can map a known model id FORWARD to its namespace without duplicating the
 * sanitization — the mapping is lossy and NOT reversible, so callers compare
 * derived names rather than parse a namespace back into an id.
 */
export function modelCacheName(modelId: string): string {
  return cacheNameFor(modelId);
}

/**
 * True when `name` is one of Eco's per-model Cache API namespaces. Lets a sweep
 * tell Eco's own model buckets apart from a retired runtime's private caches
 * (e.g. `webllm/*`) or unrelated app caches — only the `eco-local-ai-` prefix is
 * ever a candidate for removal.
 */
export function isModelCacheName(name: string): boolean {
  return name.startsWith(CACHE_NAME_PREFIX);
}

function modelDirName(modelId: string): string {
  return sanitizeModelId(modelId);
}

function sanitizeModelId(modelId: string): string {
  return modelId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function safeFileName(url: string): string {
  // Strip query strings + fragments and replace path separators so a single
  // OPFS directory holds a flat file map per model.
  const noQuery = url.split('?')[0]!.split('#')[0]!;
  return noQuery.replace(/[\\/]/g, '__');
}

async function fileToText(file: File): Promise<string> {
  // Browsers expose File.text() and File.arrayBuffer(). Test runners differ:
  // jsdom's File.text() is unreliable. Prefer arrayBuffer() + TextDecoder
  // because arrayBuffer() reflects whatever bytes the writable captured.
  if (typeof (file as File & { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === 'function') {
    const buf = await file.arrayBuffer();
    return new TextDecoder().decode(new Uint8Array(buf));
  }
  if (typeof file.text === 'function') {
    return file.text();
  }
  return '';
}
