// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * WebLLM cache bridge — Eco owns the download; WebLLM owns the serving cache.
 *
 * `@mlc-ai/web-llm` normally downloads a model's weights itself into its own
 * Cache API namespaces (`webllm/model`, `webllm/config`), then serves from
 * them. Eco cannot let it: WebKit retains fetched blobs, so every weight byte
 * MUST come through Eco's zero-retention chunked pipeline (Range chunks,
 * resume, SHA-256, storage-headroom preflight). This bridge reconciles the two:
 * it downloads through Eco's real pipeline, then PRE-POPULATES WebLLM's cache
 * with the exact keys the engine will request, so `engine.reload()` is a pure
 * cache hit (WebLLM's fetch layer does check-before-fetch and never touches the
 * network).
 *
 * Seam choice (the download injection point):
 *   Rather than reimplement streaming or teach the downloader a second storage
 *   backend, the bridge reuses `downloadModel` UNCHANGED — the file lands in
 *   Eco storage exactly as for any other runtime (whole-file, or parts-native
 *   for a shard over the Range threshold). It then reads each file back through
 *   `Storage.get()`, whose Response body composes any chunk-parts ONE AT A TIME
 *   (the same zero-retention stream `download.ts` and `storage.ts` already
 *   guarantee), and pipes that stream straight into `cache.put(...)`. So the
 *   bytes are never assembled in the JS heap on either leg, and the entire
 *   proven download path (integrity included) is reused verbatim. The Eco copy
 *   is deleted file-by-file immediately after each copy, so the transient extra
 *   disk is one file, not the whole model.
 *
 * The `model_lib` wasm is deliberately NOT bridged: it is a few-MB same-origin
 * static asset well under WebKit's retention threshold and CSP-clean under
 * `connect-src 'self'`, so the engine fetches and caches it itself on first
 * load. Bridging it would only duplicate WebLLM's own `webllm/wasm` key
 * derivation for no memory benefit.
 *
 * Resume: carried entirely by the Eco download layer (persisted chunk-parts).
 * The cache-copy leg is not itself resumable — an interruption mid-copy is
 * recovered by re-running, where the Eco download verify-skips what it already
 * has and the copies re-run (idempotent overwrites). A returning user whose
 * WebLLM cache is already populated skips both legs (the `hasModelInCache`
 * fast path).
 */

import type { AppConfig } from '@mlc-ai/web-llm';
import type { ModelConfig } from '../types';
import { AdapterError } from './types';
import { downloadModel, DownloadAbortedError, type DownloadOptions } from '../download/download';
import { buildProxyURL } from '../download/proxy';
import {
  pickStorage,
  type CacheStorageLike,
  type Storage,
} from '../download/storage';
import type { ProgressTracker } from '../download/progress';
import {
  buildWebLLMAppConfig,
  stripMlcOrgPrefix,
  webllmCacheTargetFor,
  webllmModelBaseUrl,
  webllmModelLibPathFor,
} from './webllm-config';

/** Injectable collaborators — defaulted to the real ones, overridden in tests. */
export type WebLLMCacheBridgeDeps = {
  /** Download seam. Defaults to the real `downloadModel`. */
  download?: (model: ModelConfig, options?: DownloadOptions) => Promise<unknown>;
  /** Eco storage the download writes to and the bridge reads back. Defaults to `pickStorage()`. */
  storage?: Storage;
  /** WebLLM's Cache API namespaces. Defaults to the global `caches`. */
  caches?: CacheStorageLike;
  /**
   * The real `@mlc-ai/web-llm` `hasModelInCache`. Defaults to a lazy import so
   * tests can pin the library's ACTUAL key semantics against an in-memory cache
   * instead of a hand-rolled stand-in.
   */
  hasModelInCache?: (mlcId: string, appConfig: AppConfig) => Promise<boolean>;
  /** Origin the same-origin cache keys are built against. Defaults to `location.origin`. */
  origin?: string;
};

export type WebLLMCacheBridgeOptions = WebLLMCacheBridgeDeps & {
  /** Progress tracker — the download leg feeds it exactly as `downloadModel` does. */
  tracker?: ProgressTracker;
  /** Cancels the download (and short-circuits the copy loop). */
  signal?: AbortSignal;
};

function resolveOrigin(explicit?: string): string {
  if (explicit) return explicit;
  const origin =
    typeof globalThis !== 'undefined' &&
    (globalThis as { location?: { origin?: string } }).location?.origin;
  if (!origin) {
    throw new AdapterError(
      'WebLLM cache bridge: no window.location.origin — the bridge needs an origin to build same-origin cache keys.',
      'init-failed',
      false,
    );
  }
  return origin;
}

function resolveCaches(explicit?: CacheStorageLike): CacheStorageLike {
  if (explicit) return explicit;
  if (typeof caches === 'undefined') {
    throw new AdapterError(
      'WebLLM cache bridge: Cache API (globalThis.caches) is unavailable in this environment.',
      'init-failed',
      false,
    );
  }
  return caches as unknown as CacheStorageLike;
}

async function defaultHasModelInCache(mlcId: string, appConfig: AppConfig): Promise<boolean> {
  const webllm = await import('@mlc-ai/web-llm');
  return webllm.hasModelInCache(mlcId, appConfig);
}

/**
 * True when WebLLM's cache already holds this model's weights, resolved through
 * the REAL `hasModelInCache` against the self-hosted `appConfig` (a bare call
 * would search only `prebuiltAppConfig` and never find our record). The gate the
 * sustained probe uses in place of its Eco-storage check for a `webllm` model.
 * Fails closed.
 */
export async function webllmModelInCache(
  model: ModelConfig,
  deps: Pick<WebLLMCacheBridgeDeps, 'hasModelInCache' | 'origin'> = {},
): Promise<boolean> {
  const artifact = model.artifact;
  if (!artifact?.hfId) return false;
  try {
    const origin = resolveOrigin(deps.origin);
    const mlcId = stripMlcOrgPrefix(artifact.hfId);
    const appConfig = buildWebLLMAppConfig(mlcId, origin, webllmModelLibPathFor(model));
    const hasModelInCache = deps.hasModelInCache ?? defaultHasModelInCache;
    return await hasModelInCache(mlcId, appConfig);
  } catch {
    return false;
  }
}

/**
 * Download a `webllm` model through Eco's pipeline and pre-populate WebLLM's
 * cache so `engine.reload()` is a pure cache hit. Throws on any failure — most
 * importantly, if the cache-key contract is not satisfied after a completed
 * download it fails LOUDLY (`init-failed`) rather than leaving the engine to
 * fetch weights from the network.
 */
export async function bridgeDownloadWebLLMModel(
  model: ModelConfig,
  options: WebLLMCacheBridgeOptions = {},
): Promise<void> {
  const artifact = model.artifact;
  if (!artifact?.hfId) {
    throw new AdapterError(
      `WebLLM cache bridge: catalog model "${model.id}" is missing artifact.hfId — cannot resolve its MLC id.`,
      'init-failed',
      false,
    );
  }

  const origin = resolveOrigin(options.origin);
  const mlcId = stripMlcOrgPrefix(artifact.hfId);
  const appConfig = buildWebLLMAppConfig(mlcId, origin, webllmModelLibPathFor(model));
  // The single source of truth the engine keys its cache lookups by — identical
  // to appConfig.model_list[0].model, derived here directly to avoid indexing.
  const base = webllmModelBaseUrl(mlcId, origin);
  const hasModelInCache = options.hasModelInCache ?? defaultHasModelInCache;

  // Returning-user fast path: the weights are already in WebLLM's cache, so
  // neither re-download nor re-copy. Mark the download phase complete so the
  // setup UI advances straight to smoke.
  if (await hasModelInCache(mlcId, appConfig).catch(() => false)) {
    options.tracker?.reportDownloadProgress(1, 1);
    return;
  }

  // 1. Download every file through Eco's real zero-retention pipeline.
  const download = options.download ?? downloadModel;
  await download(model, { tracker: options.tracker, signal: options.signal });

  // 2. Stream-copy each file from Eco storage into WebLLM's cache under the exact
  //    key the engine will request, then drop the Eco copy.
  const storage = options.storage ?? pickStorage();
  const cachesImpl = resolveCaches(options.caches);

  for (const filePath of artifact.files) {
    if (options.signal?.aborted) throw new DownloadAbortedError(model.id);

    const ecoKey = {
      modelId: model.id,
      url: buildProxyURL({ modelId: artifact.hfId, revision: artifact.revision, filePath }),
    };
    const entry = await storage.get(ecoKey);
    if (!entry) {
      throw new AdapterError(
        `WebLLM cache bridge: "${filePath}" for ${model.id} is missing from Eco storage after a completed download — cannot populate WebLLM's cache.`,
        'init-failed',
        false,
      );
    }

    const { scope, key } = webllmCacheTargetFor(filePath, base);
    const cache = await cachesImpl.open(scope);
    // `entry.response.body` composes any chunk-parts one at a time; `cache.put`
    // streams it into cache storage — zero-retention on both legs.
    const body = entry.response.body ?? (await entry.response.blob()).stream();
    await cache.put(new Request(key), new Response(body));

    // The Eco copy was a staging area only; free it immediately so the transient
    // extra disk stays at one file rather than a whole duplicate model.
    await storage.remove(ecoKey).catch(() => undefined);
  }

  // 3. The cache contract MUST hold now. If it doesn't, fail loudly — never fall
  //    through to letting WebLLM fetch weights from the network (WebKit retains
  //    fetched blobs; that is the entire reason this bridge exists).
  if (!(await hasModelInCache(mlcId, appConfig))) {
    throw new AdapterError(
      `WebLLM cache bridge: populated the cache for ${model.id} (${mlcId}) but hasModelInCache is still false — the cache-key contract is broken. Refusing to let WebLLM fetch weights from the network.`,
      'init-failed',
      false,
    );
  }
}
