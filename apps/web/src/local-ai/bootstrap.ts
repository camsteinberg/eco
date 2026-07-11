// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Bootstrap — wire the DI seams the local-AI sub-modules expose.
 *
 * Called once at app boot. Idempotent. Safe to call from SSR (it no-ops
 * without a browser).
 *
 * Wires:
 *   - download/download.setDownloadPlanResolver  → resolves ModelConfig
 *     into a DownloadPlan via the proxy URL + catalog metadata.
 *   - runtime/transformers-adapter.setWorkerFactory → constructs the
 *     real Worker that imports @huggingface/transformers.
 *   - runtime/lifecycle.setAdapterFactory → picks transformers vs
 *     litert per (model, profile) using runtime-router.
 *   - lifecycle/smoke.setSmokeGenerationFn → loads the model via
 *     runtime/lifecycle and streams a tiny generation.
 *
 * Also runs self-heal once on first call so the boot path is the single
 * place that touches storage cleanup.
 */

import type { ModelArtifact, ModelConfig } from './types';
import {
  type DownloadPlan,
  hasDownloadPlanResolver,
  setDownloadPlanResolver,
} from './download/download';
import { buildProxyURL, buildModelFileURL, getModelCdnBase } from './download/proxy';
import { getModel } from './catalog/catalog';
import {
  hasWorkerFactory as hasTransformersWorkerFactory,
  setWorkerFactory as setTransformersWorkerFactory,
  TransformersAdapter,
} from './runtime/transformers-adapter';
import {
  hasLiteRTEngineFactory,
  setLiteRTEngineFactory,
  LiteRTAdapter,
  type LiteRTEngine,
} from './runtime/litert-adapter';
import {
  setAdapterFactory,
  hasAdapterFactory,
  loadModel as loadModelInLifecycle,
  generate as generateThroughLifecycle,
} from './runtime/lifecycle';
import { selectRuntime } from './runtime/runtime-router';
import { getDeviceProfile } from './device/profile';
import { setSmokeGenerationFn, hasSmokeGenerationFn } from './lifecycle/smoke';
import { reconcileReadySlots, runSelfHeal } from './lifecycle/self-heal';
import { pickStorage } from './download/storage';
import { logger } from '../lib/logger';

const CACHE_REPAIRED_HINT_KEY = 'eco-local-ai-cache-repaired-v1';

let initialized = false;

// Memoized LiteRT WASM-runtime load. `loadLiteRtLm()` is global + single-shot
// (throws if called while already loading/loaded), so the engine factory awaits
// this shared promise rather than re-invoking it per model load.
let litertWasmReady: Promise<unknown> | null = null;

export type BootstrapOptions = {
  /** Skip self-heal at boot — only used in tests. */
  skipSelfHeal?: boolean;
};

/**
 * Initialize all DI seams. Idempotent — subsequent calls return the
 * existing initialization. Safe under SSR (no-op when window is absent).
 */
export async function bootstrapLocalAi(options?: BootstrapOptions): Promise<void> {
  if (initialized) return;
  if (typeof window === 'undefined') return;
  initialized = true;

  // ── Download plan resolver ──────────────────────────────────────────────
  if (!hasDownloadPlanResolver()) {
    setDownloadPlanResolver(async (model: ModelConfig): Promise<DownloadPlan> => {
      const artifact = model.artifact;
      if (!artifact) {
        throw new Error(
          `[local-ai/bootstrap] catalog model "${model.id}" is missing artifact.hfId/revision/files — cannot build DownloadPlan. Fix catalog-data.json.`,
        );
      }

      // Try the manifest endpoint first — it returns reviewed byte sizes
      // and OIDs for every file, giving progress UI accurate numbers. If
      // the manifest is unavailable, fall back to the heuristic estimator.
      const manifestPlan = await fetchManifestPlan(model.id, artifact);
      if (manifestPlan) return manifestPlan;

      return {
        modelId: model.id,
        files: filePlanFromArtifact(artifact, model.sizeGB),
      };
    });
  }

  // ── Transformers.js worker factory ──────────────────────────────────────
  if (!hasTransformersWorkerFactory()) {
    setTransformersWorkerFactory(() => {
      // The URL form Webpack expects for a module Worker.
      return new Worker(
        new URL('../workers/local-ai-transformers-worker.ts', import.meta.url),
        { type: 'module' },
      ) as unknown as ReturnType<NonNullable<Parameters<typeof setTransformersWorkerFactory>[0]>>;
    });
  }

  // ── LiteRT-LM engine factory (dev-only eval lane) ───────────────────────
  // Dynamic import keeps the ~38 MB WASM runtime out of the boot bundle —
  // it only loads when a `litert` model is actually selected.
  if (!hasLiteRTEngineFactory()) {
    setLiteRTEngineFactory(async ({ model, maxNumTokens }) => {
      const mod = await import('@litert-lm/core');
      // Pre-load LiteRT's WASM runtime from same-origin STATIC assets (copied
      // into public/litert-wasm/ at build — scripts/copy-runtime-assets.mjs)
      // so it never reaches its jsDelivr CDN default — Eco's `script-src
      // 'self'` CSP blocks the CDN script. Not the /api/litert-wasm route:
      // Vercel function bundles omit node_modules (outputFileTracingIncludes
      // is not honored), so that route 404s in production — this killed every
      // real-prod Gemma load until 2026-07-03. Engine.create() internally uses
      // the already-loaded global, so the CDN fallback is never hit.
      if (!litertWasmReady) {
        const wasmBase = new URL('/litert-wasm/', window.location.origin).toString();
        litertWasmReady = mod.loadLiteRtLm(wasmBase).catch((err: unknown) => {
          litertWasmReady = null; // allow a retry on a later load attempt
          throw err;
        });
      }
      await litertWasmReady;
      const engine = await mod.Engine.create({
        model,
        mainExecutorSettings: { maxNumTokens },
      });
      // Cast through `unknown` — the published Engine surface is wider than
      // the narrow slice the adapter's LiteRTEngine contract requires.
      return engine as unknown as LiteRTEngine;
    });
  }

  // ── Adapter factory ─────────────────────────────────────────────────────
  if (!hasAdapterFactory()) {
    setAdapterFactory((model: ModelConfig) => {
      const profile = getDeviceProfile();
      const routing = selectRuntime(model, profile);
      if (routing.runtime === 'litert') {
        // Same Cache API backend the download pipeline writes to, so the
        // adapter streams the already-downloaded `.litertlm` instead of
        // re-fetching it.
        return new LiteRTAdapter({ storage: pickStorage() });
      }
      return new TransformersAdapter({ storage: pickStorage() });
    });
  }

  // ── Smoke generation seam ───────────────────────────────────────────────
  if (!hasSmokeGenerationFn()) {
    setSmokeGenerationFn(async function* (model, messages, opts) {
      await loadModelInLifecycle(model, { signal: opts.signal });
      // Hand the smoke runner the load/generation boundary so the token
      // deadline starts now — not during the (slow, cold) load above.
      opts.onLoadComplete?.();
      yield* generateThroughLifecycle(messages, {
        signal: opts.signal,
        maxTokens: opts.maxTokens,
      });
    });
  }

  // ── Self-heal at boot ──────────────────────────────────────────────────
  if (!options?.skipSelfHeal) {
    try {
      await runSelfHeal();
    } catch {
      // Self-heal failures must never crash app boot.
    }

    // Reconcile cached files against each 'ready' slot's file plan. If
    // anything fails verification, repair the cache and flip the slot to
    // 'preparing' so the next setup pass re-fetches cleanly. Failures
    // don't crash boot.
    //
    // Verification uses ONLY reviewed manifest sizes — never the heuristic
    // estimator (peekDownloadPlan falls back to it). Heuristic sizes exist
    // for progress UI; verifying cached bytes against estimates declares
    // every healthy cache corrupt and wipes it (observed live 2026-06-11: a
    // manifest timeout at boot erased a just-downloaded 1.4GB model and
    // flipped the ready slot to 'preparing'). When the manifest is
    // unreachable this boot, skip verification — real corruption is still
    // caught at load time and on the next boot with a reachable manifest.
    try {
      await reconcileReadySlots(
        resolveReconcileFilePlan,
        {
          onCacheRepaired: ({ modelId, slot, removed }) => {
            try {
              window.sessionStorage?.setItem(
                CACHE_REPAIRED_HINT_KEY,
                JSON.stringify({ modelId, slot, removed, at: Date.now() }),
              );
            } catch {
              // sessionStorage unavailable — best-effort only.
            }
          },
        },
      );
    } catch {
      // Slot reconciliation must never crash app boot.
    }
  }
}

/** Test-only: reset so the next bootstrap call re-runs. */
export function _resetBootstrapForTesting(): void {
  initialized = false;
}

/**
 * Plan resolver used ONLY by boot-time slot reconciliation.
 *
 * Returns reviewed manifest sizes, or null when the manifest is
 * unavailable — NEVER the heuristic estimator. Reconciliation deletes
 * cached files whose sizes don't match the plan, so verifying against
 * estimates would declare every healthy cache corrupt and wipe it.
 * Returning null makes reconcileReadySlots skip the model this boot.
 *
 * Exported for unit tests (the no-heuristic-fallback contract is the
 * regression guard for the 2026-06-11 cache-wipe incident).
 */
export async function resolveReconcileFilePlan(
  modelId: string,
): Promise<ReadonlyArray<{ url: string; sizeBytes: number }> | null> {
  const model = getModel(modelId);
  if (!model?.artifact) return null;
  const plan = await fetchManifestPlan(model.id, model.artifact);
  return plan?.files ?? null;
}

// ── Manifest fetch ──────────────────────────────────────────────────────
//
// The manifest endpoint returns reviewed byte sizes and OIDs per file,
// giving the download pipeline accurate progress tracking. When the
// endpoint is reachable, the heuristic estimator below is bypassed
// entirely. When it is not (network error, 4xx, 5xx, malformed response),
// the heuristic kicks in silently so boot never fails.

type ManifestFile = { path: string; sizeBytes: number; oid: string };
type ManifestResponse = {
  modelId: string;
  hfId: string;
  revision: string;
  files: ManifestFile[];
};

function isManifestResponse(value: unknown): value is ManifestResponse {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.modelId !== 'string') return false;
  if (typeof obj.hfId !== 'string') return false;
  if (typeof obj.revision !== 'string') return false;
  if (!Array.isArray(obj.files) || obj.files.length === 0) return false;
  return obj.files.every((f: unknown) => {
    if (typeof f !== 'object' || f === null) return false;
    const file = f as Record<string, unknown>;
    return typeof file.path === 'string'
      && typeof file.sizeBytes === 'number'
      && file.sizeBytes > 0
      && typeof file.oid === 'string';
  });
}

async function fetchManifestPlan(
  modelId: string,
  artifact: ModelArtifact,
): Promise<DownloadPlan | null> {
  try {
    // 3s timeout safety net so a slow/unreachable manifest endpoint
    // doesn't stall boot — heuristic fallback takes over within seconds
    // instead of waiting for the browser's default fetch timeout.
    const response = await fetch(
      `/api/local-models/manifest/${modelId}`,
      { cache: 'force-cache', signal: AbortSignal.timeout(3_000) },
    );
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!isManifestResponse(data)) return null;

    // Build file-to-size/oid lookup from the manifest.
    const sizeByPath = new Map<string, number>();
    const oidByPath = new Map<string, string>();
    for (const file of data.files) {
      sizeByPath.set(file.path, file.sizeBytes);
      oidByPath.set(file.path, file.oid);
    }

    // If the manifest is incomplete (any catalog file is missing from it),
    // the silent filter-out at the end would produce a DownloadPlan that
    // skips real files — and the model would then fail at load time. Treat
    // an incomplete manifest as a fetch failure and fall back to the
    // heuristic plan (which lists every catalog file with an estimate).
    const missingFromManifest = artifact.files.filter(
      (filePath) => !sizeByPath.has(filePath),
    );
    if (missingFromManifest.length > 0) {
      logger.warn(
        `[local-ai/bootstrap] manifest for "${modelId}" missing ${missingFromManifest.length} `
        + `file(s) (e.g. ${missingFromManifest[0]}); using heuristic sizes`,
      );
      return null;
    }

    const cdnBase = getModelCdnBase();
    return {
      modelId,
      files: artifact.files.map((filePath) => {
        const parsed = {
          modelId: artifact.hfId,
          revision: artifact.revision,
          filePath,
        };
        return {
          // Stable storage identity — always the proxy path (see DownloadFileSpec).
          url: buildProxyURL(parsed),
          // Transport source — the CDN direct URL when configured, else the proxy.
          fetchUrl: buildModelFileURL(parsed, cdnBase),
          sizeBytes: sizeByPath.get(filePath)!,
          // Reviewed LFS SHA-256 — lets the download path verify the assembled
          // bytes (both the Range and whole-GET paths check this when present).
          oid: oidByPath.get(filePath),
        };
      }),
    };
  } catch {
    // Network error, JSON parse failure, timeout, etc. — fall back silently.
    logger.warn(`[local-ai/bootstrap] manifest fetch failed for "${modelId}", using heuristic sizes`);
    return null;
  }
}

// ── File-plan helpers (fallback) ────────────────────────────────────────
//
// Fallback estimator used when the manifest endpoint is unreachable.
// Builds a DownloadPlan from the catalog's `artifact` field. Sizes are
// estimates split across files by extension class (weight files get the
// bulk; metadata files get small fixed budgets). The storage layer
// verifies actual byte counts at put time, so wrong estimates only
// affect progress UI, not data integrity.

type FileSizeClass = 'weight' | 'metadata-large' | 'metadata-small';

function classifyFile(filePath: string): FileSizeClass {
  if (
    filePath.endsWith('.onnx_data')
    || filePath.endsWith('.bin')
    || filePath.endsWith('.onnx')
  ) {
    return 'weight';
  }
  // tokenizer.model is SentencePiece (hundreds of KB, not GB). Lumping it
  // with weight files allocated it ~765 MB of Phi-3's budget and caused a
  // visible progress-bar jump when the small file finished early.
  if (
    filePath.endsWith('tokenizer.json')
    || filePath.endsWith('tokenizer.model')
  ) {
    return 'metadata-large';
  }
  return 'metadata-small';
}

function filePlanFromArtifact(
  artifact: ModelArtifact,
  sizeGB: number,
): { url: string; fetchUrl: string; sizeBytes: number }[] {
  const cdnBase = getModelCdnBase();
  const totalWeightBytes = Math.round(sizeGB * 1_073_741_824);
  // Allocate fixed budgets to metadata files; the rest goes to weights.
  // These are progress-UI estimates — actual bytes are written by storage.
  const METADATA_LARGE = 4_194_304; // ~4 MB for tokenizer.json
  const METADATA_SMALL = 16_384; // ~16 KB for small JSON / txt / jinja

  const weightFiles = artifact.files.filter(
    (f) => classifyFile(f) === 'weight',
  );
  const perWeight = weightFiles.length > 0
    ? Math.max(1, Math.round(totalWeightBytes / weightFiles.length))
    : 0;

  return artifact.files.map((filePath) => {
    const cls = classifyFile(filePath);
    const sizeBytes =
      cls === 'weight' ? perWeight
        : cls === 'metadata-large' ? METADATA_LARGE
          : METADATA_SMALL;
    const parsed = {
      modelId: artifact.hfId,
      revision: artifact.revision,
      filePath,
    };
    return {
      // Stable storage identity — always the proxy path (see DownloadFileSpec).
      url: buildProxyURL(parsed),
      // Transport source — the CDN direct URL when configured, else the proxy.
      fetchUrl: buildModelFileURL(parsed, cdnBase),
      sizeBytes,
    };
  });
}

