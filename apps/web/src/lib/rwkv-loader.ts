// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * RWKV model weight loader.
 *
 * Handles loading RWKV-7 .st format weights from the Cache API,
 * using the same https://eco-model.cache/ scheme as the existing model download
 * pipeline. RWKV models are single-file (.st) unlike ONNX shards.
 */

/**
 * Build the cache key for an RWKV model's .st file.
 * Follows the https://eco-model.cache/ scheme used by model-download.ts.
 */
export function getRwkvCacheKey(modelId: string): string {
  const safeId = modelId.replace(/\//g, '-');
  return `https://eco-model.cache/eco-model-${safeId}/weights.st`;
}

/**
 * Get the Cache API storage name for an RWKV model.
 */
export function getRwkvCacheName(modelId: string): string {
  const safeId = modelId.replace(/\//g, '-');
  return `eco-model-${safeId}`;
}

/**
 * Check whether RWKV model weights are cached in the Cache API.
 */
export async function isRwkvCached(modelId: string): Promise<boolean> {
  if (typeof caches === 'undefined') return false;

  try {
    const cache = await caches.open(getRwkvCacheName(modelId));
    const response = await cache.match(getRwkvCacheKey(modelId));
    return response !== undefined;
  } catch {
    return false;
  }
}

/**
 * Load RWKV model weights from the Cache API.
 *
 * @throws {Error} If the model weights are not found in the cache.
 */
export async function loadRwkvWeights(modelId: string): Promise<ArrayBuffer> {
  if (typeof caches === 'undefined') {
    throw new Error(`RWKV weights for ${modelId} not found in cache: Cache API unavailable`);
  }

  const cache = await caches.open(getRwkvCacheName(modelId));
  const response = await cache.match(getRwkvCacheKey(modelId));

  if (!response) {
    throw new Error(`RWKV weights for ${modelId} not found in cache. Download the model first.`);
  }

  return response.arrayBuffer();
}

/**
 * Store RWKV model weights in the Cache API.
 * Used during model download to cache the .st file.
 */
export async function storeRwkvWeights(
  modelId: string,
  data: ArrayBuffer,
): Promise<void> {
  if (typeof caches === 'undefined') {
    throw new Error('Cache API unavailable');
  }

  const cache = await caches.open(getRwkvCacheName(modelId));
  const response = new Response(data, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.byteLength),
    },
  });

  await cache.put(new Request(getRwkvCacheKey(modelId)), response);
}
