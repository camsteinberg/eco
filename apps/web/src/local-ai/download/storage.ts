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
  get(key: StorageKey): Promise<CachedEntry | null>;
  has(key: StorageKey): Promise<boolean>;
  verify(key: StorageKey, expectedSizeBytes: number): Promise<boolean>;
  remove(key: StorageKey): Promise<void>;
  listForModel(modelId: string): Promise<{ url: string; sizeBytes: number | null }[]>;
  clearModel(modelId: string): Promise<void>;
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

  async get(key: StorageKey): Promise<CachedEntry | null> {
    const cache = await this.cacheStorage.open(cacheNameFor(key.modelId));
    const cached = await cache.match(key.url);
    if (!cached) return null;
    const sizeBytes = readCacheSize(cached);
    if (sizeBytes == null) return null;
    return { response: cached, sizeBytes };
  }

  async has(key: StorageKey): Promise<boolean> {
    const cache = await this.cacheStorage.open(cacheNameFor(key.modelId));
    const cached = await cache.match(key.url);
    return cached != null;
  }

  async verify(key: StorageKey, expectedSizeBytes: number): Promise<boolean> {
    const entry = await this.get(key);
    if (!entry) return false;
    return entry.sizeBytes === expectedSizeBytes;
  }

  async remove(key: StorageKey): Promise<void> {
    const cache = await this.cacheStorage.open(cacheNameFor(key.modelId));
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
    const entry = await this.get(key);
    return entry?.sizeBytes === expectedSizeBytes;
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

function cacheNameFor(modelId: string): string {
  return CACHE_NAME_PREFIX + sanitizeModelId(modelId);
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
