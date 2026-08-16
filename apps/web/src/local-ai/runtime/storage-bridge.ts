// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Storage bridge — translates the download `Storage` into the Web Cache
 * API shape that Transformers.js v4's `env.customCache` expects.
 *
 * Why this exists: TJS v4 cannot read OPFS or Cache API handles directly.
 * It accepts a `customCache` object that implements `match(request)` and
 * `put(request, response)` in the Web Cache API style, with HuggingFace
 * URLs as the request keys. This module wraps the path-keyed `Storage`
 * in that shape so we keep ONE source of truth for cached model weights
 * — the same bytes the download pipeline wrote.
 *
 * Notes on the bridge:
 *   - `match(request)` reads the URL, converts it to a storage key, and
 *     reconstructs a Response. If the entry is missing or fails verify,
 *     returns undefined (TJS falls through to remote per
 *     `env.allowRemoteModels`).
 *   - `put(request, response)` writes the response through storage,
 *     which stamps `x-eco-cache-size-bytes` on the way in.
 *   - Null guard on `match(request)`: TJS issue #1249 had `match` called
 *     with undefined; guard returns undefined safely.
 *
 * The bridge is scoped to a single modelId — multiple models in flight
 * each get their own bridge instance so cache writes route to the right
 * Storage namespace.
 */

import type { Storage } from '../download/storage';

export type TransformersCacheLike = {
  match(request: RequestInfo | URL | undefined): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
};

export type StorageBridgeOptions = {
  storage: Storage;
  modelId: string;
};

/**
 * Build a `customCache`-shaped object backed by the download `Storage`.
 *
 *   const bridge = createStorageBridge({ storage, modelId: 'local/qwen3-0.6b' });
 *   env.useCustomCache = true;
 *   env.customCache = bridge;
 */
export function createStorageBridge(options: StorageBridgeOptions): TransformersCacheLike {
  const { storage, modelId } = options;

  return {
    async match(request) {
      if (!request) return undefined;
      const url = toUrl(request);
      if (!url) return undefined;
      const entry = await storage.get({ modelId, url });
      if (!entry) return undefined;
      // The cached Response omits `Content-Length` (the storage layer tags its
      // own `x-eco-cache-size-bytes` instead — Invariant 6). But TJS /
      // onnxruntime-web reads `Content-Length` to preallocate its read buffer;
      // without it, it re-grows the WASM heap while streaming a multi-hundred-MB
      // weights file, which is slow on weak devices ("Unable to determine
      // content-length … expand buffer when needed", observed on a 4-core iGPU
      // loading a 1.1 GB model). Hand the loader our OWN verified size so it can
      // size the buffer once. This lives in the bridge, not `storage.ts`, so it
      // never becomes a CDN-size trust path (Invariant 6 stays intact).
      return withContentLength(entry.response, entry.sizeBytes);
    },

    async put(request, response) {
      const url = toUrl(request);
      if (!url) return;
      // Never clobber a parts-native manifest with a whole-file body. TJS only
      // calls put() after a REMOTE fetch (a cache miss under allowRemoteModels);
      // for a chunked weight already stored parts-native that would both destroy
      // the manifest and attempt the exact single huge Cache-API put that
      // parts-native exists to avoid (the WebKit-mobile tab kill). The cached
      // bytes are already correct, so skipping is safe.
      if (await storage.isPartsNative?.({ modelId, url })) return;
      await storage.put({ modelId, url }, response);
    },
  };
}

/**
 * Return a copy of `response` with `Content-Length` set to the verified byte
 * size. Cached-Response headers are immutable, so we reconstruct — streaming
 * the same body by reference (no copy, O(1) heap).
 */
function withContentLength(response: Response, sizeBytes: number): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Length', String(sizeBytes));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function toUrl(request: RequestInfo | URL): string | null {
  if (typeof request === 'string') return request;
  if (request instanceof URL) return request.toString();
  // Request-like (Request itself or compatible shape).
  const candidate = request as { url?: unknown };
  return typeof candidate.url === 'string' ? candidate.url : null;
}
