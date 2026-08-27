// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Smoke — verify a freshly-assigned model actually generates a token.
 *
 * The driver uses an active map plus try/finally so the slot's active
 * flag is ALWAYS released — any exception path triggers cleanup.
 *
 * Behavior:
 *   - `runSmoke(slot, model)` calls into a generation seam (defaults to
 *     lifecycle.generate / runtime.loadModel) and waits for the first
 *     token or a 15s deadline.
 *   - On success: returns { passed: true, firstTokenMs }.
 *   - On error / timeout: returns { passed: false, reason }.
 *   - Never throws unless cancelled via signal.
 *
 * The smoke runner does not write slot status — callers do, after
 * deciding what the result means in their context (settings vs first-
 * touch wizard handle errors differently).
 *
 * Diagnostics: each runSmoke invocation records a structured
 * `LocalAiDiagnostic` entry via `recordDiagnostic()`. This captures
 * WebGPU state, cache probes, load/generation timings, error details,
 * and lifecycle phase events — so we can see WHY a model fails, not
 * just that it failed. The diagnostic is recorded in a finally block
 * to guarantee capture even on unexpected throws.
 */

import type { ModelConfig, Slot } from '../types';
import type { ChatMessage, TokenEvent } from '../runtime/types';
import type { DiagnosticPhase, LocalAiDiagnostic } from '../diagnostics/capture';
import { recordDiagnostic } from '../diagnostics/capture';
import type { WebGPUAdapterProbe } from '../device/profile';
import {
  getDeviceProfile,
  getDiagnosticEnv,
  getHardwareConcurrency,
  probeWebGPUAdapter,
} from '../device/profile';
import { profileKey } from '../evidence/ledger';
import { getActiveAdapter } from '../runtime/lifecycle';
import type { RuntimeBackend } from '../runtime/types';

// ─── Generation seam ───────────────────────────────────────────────────────

/**
 * Production wiring: load the model via `runtime/lifecycle.loadModel`,
 * then generate via `runtime/lifecycle.generate`. Tests inject a fake.
 *
 * Seams SHOULD call `options.onLoadComplete()` the moment the model load
 * finishes — that hands the smoke runner the load/generation boundary so
 * the token deadline only starts once the model is actually loaded. Seams
 * that never call it fall back to "first yielded event implies load done."
 */
export type SmokeGenerationFn = (
  model: ModelConfig,
  messages: ChatMessage[],
  options: { signal: AbortSignal; maxTokens: number; onLoadComplete?: () => void },
) => AsyncIterable<TokenEvent>;

let generationFn: SmokeGenerationFn | null = null;

export function setSmokeGenerationFn(fn: SmokeGenerationFn | null): void {
  generationFn = fn;
}

export function hasSmokeGenerationFn(): boolean {
  return generationFn != null;
}

// ─── Active flag ───────────────────────────────────────────────────────────

const activeSlots = new Set<Slot>();

export function isSmokeActive(slot: Slot): boolean {
  return activeSlots.has(slot);
}

// ─── Smoke runner ──────────────────────────────────────────────────────────

const SMOKE_PROMPT = 'Say only the word OK and stop.';
/** Token deadline — starts AFTER the model load completes. */
const SMOKE_TIMEOUT_MS = 15_000;
/**
 * Cold-load budget floor — a strong device loading a small model. A first-time
 * visitor's load reads the full weights from Cache API, creates the
 * ONNX/WebGPU session, and compiles shaders with no warm caches — 25-45s on a
 * fast M-series Mac. 15s here bricked every fresh-profile setup in prod
 * (2026-06-09). Weak devices and large models scale ABOVE this via
 * `computeSmokeLoadBudgetMs`.
 */
export const SMOKE_LOAD_BUDGET_MIN_MS = 120_000;
/**
 * Cold-load budget ceiling — a weak device loading a large model. Bounded so a
 * genuinely stuck load (WebGPU deadlock, blocklisted driver) still fails in a
 * tolerable time instead of hanging the setup UI indefinitely.
 */
export const SMOKE_LOAD_BUDGET_MAX_MS = 300_000;
const SMOKE_MAX_TOKENS = 8;

/** Device weakness / large-model widening steps for the cold-load budget. */
const WEAK_DEVICE_LOAD_BONUS_MS = 120_000;
const LARGE_MODEL_LOAD_BONUS_MS = 60_000;
/** A model at or above this download size counts as "large" for the budget. */
const LARGE_MODEL_GB = 1;

export type SmokeLoadBudgetInput = {
  /** Reported device memory in GB; 0 when the browser doesn't report it. */
  deviceMemoryGB: number;
  /** Logical CPU core count; null when the browser doesn't expose it. */
  hardwareConcurrency: number | null;
  isMobile: boolean;
  /** Model download size in GB (`ModelConfig.sizeGB`); undefined when unknown. */
  modelSizeGB?: number;
};

/**
 * Adaptive cold-load budget. The old fixed 120s cap killed legit-but-slow
 * loads on weak hardware — Cam's 4-core x86 iGPU laptop aborted a 1.15GB
 * Bonsai load at exactly 120003ms (2026-07-01). A weak device and/or a large
 * model gets more headroom, bounded to [MIN, MAX].
 *
 * "Weak" = ANY of: mobile, ≤4 logical cores, or ≤4GB reported RAM. Unknown
 * signals (RAM 0 = unreported, cores null) do NOT count as weak on their own —
 * we only widen when we have positive evidence the device is modest, so a
 * strong device with a stingy `navigator` never over-waits.
 */
export function computeSmokeLoadBudgetMs(input: SmokeLoadBudgetInput): number {
  const { deviceMemoryGB, hardwareConcurrency, isMobile, modelSizeGB } = input;

  const lowCores = hardwareConcurrency !== null && hardwareConcurrency <= 4;
  const lowMemory = deviceMemoryGB > 0 && deviceMemoryGB <= 4;
  const isWeakDevice = isMobile || lowCores || lowMemory;

  let budget = SMOKE_LOAD_BUDGET_MIN_MS;
  if (isWeakDevice) budget += WEAK_DEVICE_LOAD_BONUS_MS;
  if ((modelSizeGB ?? 0) >= LARGE_MODEL_GB) budget += LARGE_MODEL_LOAD_BONUS_MS;

  return Math.min(Math.max(budget, SMOKE_LOAD_BUDGET_MIN_MS), SMOKE_LOAD_BUDGET_MAX_MS);
}

/**
 * Default cold-load budget for `model` on the current device. Reads device
 * signals through `device/profile.ts` (Invariant 5) and falls back to the MIN
 * floor's inputs if the profile read throws.
 *
 * Exported for the sustained-probe runner, which enforces the same budget on
 * its load phase — a probe load that never settles must fail by deadline, not
 * wedge with a live crash-evidence marker.
 */
export function defaultLoadBudgetMs(model: ModelConfig): number {
  let deviceMemoryGB = 0;
  let isMobile = false;
  try {
    const profile = getDeviceProfile();
    deviceMemoryGB = profile.deviceMemoryGB;
    isMobile = profile.isMobile;
  } catch {
    // Fall through to conservative defaults — a profile read should never
    // break smoke, and unknown signals resolve to the MIN floor.
  }
  return computeSmokeLoadBudgetMs({
    deviceMemoryGB,
    hardwareConcurrency: getHardwareConcurrency(),
    isMobile,
    modelSizeGB: model.sizeGB,
  });
}

export type SmokeOptions = {
  /** Override the token deadline. Tests pass small values. */
  timeoutMs?: number;
  /**
   * Override the cold-load budget. When omitted but `timeoutMs` is provided,
   * falls back to `timeoutMs` (legacy combined-deadline semantics so older
   * tests and callers keep one knob).
   */
  loadTimeoutMs?: number;
  /** Override the clock — for fake-timer tests. */
  now?: () => number;
  /** Caller-supplied abort signal. */
  signal?: AbortSignal;
  /** Override the generation seam for this call (otherwise uses registered seam). */
  generationFn?: SmokeGenerationFn;
  /** Skip diagnostic capture (tests that don't have localStorage). */
  skipDiagnostics?: boolean;
  /**
   * Fires once, when the model load finishes and the first-token deadline
   * starts. The setup runner relays it to the progress tracker as the smoke
   * `running` stage. Not called if the load is aborted or never settles.
   */
  onLoadComplete?: () => void;
};

export type SmokeResult =
  | { passed: true; firstTokenMs: number; durationMs: number; tokensReceived: number }
  | { passed: false; reason: string; durationMs: number };

/**
 * Run a smoke generation for `model` and report whether it produced a
 * first token within the timeout. Always releases the slot's active flag.
 */
export async function runSmoke(
  slot: Slot,
  model: ModelConfig,
  options?: SmokeOptions,
): Promise<SmokeResult> {
  const now = options?.now ?? (() => Date.now());
  const tokenTimeoutMs = options?.timeoutMs ?? SMOKE_TIMEOUT_MS;
  const loadTimeoutMs =
    options?.loadTimeoutMs ?? options?.timeoutMs ?? defaultLoadBudgetMs(model);
  const fn = options?.generationFn ?? generationFn;

  if (!fn) {
    const result: SmokeResult = {
      passed: false,
      reason: 'No smoke generation function registered. Wire setSmokeGenerationFn at boot.',
      durationMs: 0,
    };
    if (!options?.skipDiagnostics) {
      try {
        const earlyEvents: { at: number; phase: DiagnosticPhase; note?: string }[] = [];
        const earlyStart = perfNow();
        const pushEarlyEvent = (phase: DiagnosticPhase, note?: string): void => {
          earlyEvents.push({ at: Math.round(perfNow() - earlyStart), phase, note });
        };
        const webgpu = await probeWebGPU(pushEarlyEvent);
        const env = await getDiagnosticEnv();
        pushEarlyEvent('load-fail', result.reason);
        recordDiagnostic({
          schemaVersion: 2,
          recordedAt: new Date().toISOString(),
          modelId: model.id,
          profileKey: getProfileKey(),
          runtimeAdapter: getRuntimeAdapter(model),
          outcome: 'smoke-fail',
          durations: { loadMs: null, firstTokenMs: null, totalMs: 0 },
          tokensReceived: 0,
          error: { message: result.reason },
          webgpu,
          cache: null,
          env,
          events: earlyEvents,
        });
      } catch {
        // Never let diagnostic recording break smoke.
      }
    }
    return result;
  }

  if (activeSlots.has(slot)) {
    const result: SmokeResult = {
      passed: false,
      reason: `Smoke for ${slot} is already running.`,
      durationMs: 0,
    };
    if (!options?.skipDiagnostics) {
      try {
        const earlyEvents: { at: number; phase: DiagnosticPhase; note?: string }[] = [];
        const earlyStart = perfNow();
        const pushEarlyEvent = (phase: DiagnosticPhase, note?: string): void => {
          earlyEvents.push({ at: Math.round(perfNow() - earlyStart), phase, note });
        };
        const webgpu = await probeWebGPU(pushEarlyEvent);
        const env = await getDiagnosticEnv();
        pushEarlyEvent('load-fail', result.reason);
        recordDiagnostic({
          schemaVersion: 2,
          recordedAt: new Date().toISOString(),
          modelId: model.id,
          profileKey: getProfileKey(),
          runtimeAdapter: getRuntimeAdapter(model),
          outcome: 'smoke-fail',
          durations: { loadMs: null, firstTokenMs: null, totalMs: 0 },
          tokensReceived: 0,
          error: { message: result.reason },
          webgpu,
          cache: null,
          env,
          events: earlyEvents,
        });
      } catch {
        // Never let diagnostic recording break smoke.
      }
    }
    return result;
  }

  const startedAt = now();
  activeSlots.add(slot);

  const internal = new AbortController();
  const cancelOnExternal = (): void => internal.abort();
  const externalSignal = options?.signal;
  if (externalSignal) {
    if (externalSignal.aborted) internal.abort();
    else externalSignal.addEventListener('abort', cancelOnExternal, { once: true });
  }

  // Two-phase deadline: the load budget runs first; the (shorter) token
  // deadline replaces it the moment the seam signals load completion.
  let timer = setTimeout(() => internal.abort(), loadTimeoutMs);

  let firstTokenAt: number | null = null;
  let tokensReceived = 0;
  // Post-filter tokens carrying at least one non-whitespace character. A smoke
  // passes only if the user would have seen *something* — a reply that is
  // entirely think-block (all filtered) or pure whitespace is a failure, not a
  // pass (HON-5).
  let visibleTextTokens = 0;
  let workerCompletionTokens = 0;
  let errorReason: string | null = null;
  let caughtError: unknown = null;

  // Diagnostic event collector
  const diagEvents: { at: number; phase: DiagnosticPhase; note?: string }[] = [];
  const diagStart = perfNow();

  const pushDiagEvent = (phase: DiagnosticPhase, note?: string): void => {
    diagEvents.push({ at: Math.round(perfNow() - diagStart), phase, note });
  };

  // WebGPU probe (never throws — captures state for diagnostics)
  const webgpuState = await probeWebGPU(pushDiagEvent);

  // Cache probe (never throws)
  const cacheState = await probeCache(model, pushDiagEvent);

  // ── Early exit when model artifacts are not downloaded ───────────────
  // If the cache namespace is empty (0 files) or doesn't exist, the model
  // hasn't been downloaded yet. Running smoke would trigger a cold download
  // of potentially hundreds of MB into the 15s timeout budget — that's not
  // a smoke failure, it's an orchestration state. Return early with a
  // specific reason so callers can distinguish "needs download" from "model
  // is broken."
  //
  // A `webllm` model is the exception: Eco storage is only a staging area —
  // the cache bridge copies every file into WebLLM's own Cache API
  // namespaces and empties the staging cache after a successful download
  // (see webllm-cache-bridge.ts), so the Eco namespace is empty precisely
  // when the download SUCCEEDED. The authoritative signal is WebLLM's cache,
  // checked through the same fail-closed gate the sustained probe uses.
  let cacheIsEmpty = !cacheState || !cacheState.hit || (cacheState.fileCount ?? 0) === 0;
  if (model.runtime === 'webllm') {
    let inWebLLMCache = false;
    try {
      inWebLLMCache = await (
        await import('../runtime/webllm-cache-bridge')
      ).webllmModelInCache(model);
    } catch {
      // Fail closed — a bridge chunk that cannot load means the model
      // cannot serve either, and runSmoke never throws.
    }
    pushDiagEvent('cache-probe', `webllm cache: ${inWebLLMCache ? 'hit' : 'miss'}`);
    cacheIsEmpty = !inWebLLMCache;
  }
  if (cacheIsEmpty) {
    const reason = 'Model not yet downloaded';
    pushDiagEvent('load-fail', reason);
    const earlyResult: SmokeResult = { passed: false, reason, durationMs: now() - startedAt };

    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', cancelOnExternal);
    activeSlots.delete(slot);

    if (!options?.skipDiagnostics) {
      try {
        const env = await getDiagnosticEnv();
        recordDiagnostic({
          schemaVersion: 2,
          recordedAt: new Date().toISOString(),
          modelId: model.id,
          profileKey: getProfileKey(),
          runtimeAdapter: getRuntimeAdapter(model),
          outcome: 'smoke-fail',
          durations: { loadMs: null, firstTokenMs: null, totalMs: earlyResult.durationMs },
          tokensReceived: 0,
          error: { message: reason },
          webgpu: webgpuState,
          cache: cacheState,
          env,
          events: diagEvents,
        });
      } catch {
        // Never let diagnostic recording break smoke.
      }
    }

    return earlyResult;
  }

  pushDiagEvent('load-start', model.id);

  let loadFinished = false;
  // Fires when the seam reports the model load is done: records the REAL
  // load-finish moment (the old code stamped it at iterable construction,
  // which is synchronous — diagnostics reported loadMs=0 forever) and swaps
  // the load budget for the token deadline.
  const handleLoadComplete = (): void => {
    if (loadFinished || internal.signal.aborted) return;
    loadFinished = true;
    pushDiagEvent('load-finish');
    clearTimeout(timer);
    timer = setTimeout(() => internal.abort(), tokenTimeoutMs);
    options?.onLoadComplete?.();
  };

  try {
    const iterable = fn(
      model,
      [{ role: 'user', content: SMOKE_PROMPT }],
      { signal: internal.signal, maxTokens: SMOKE_MAX_TOKENS, onLoadComplete: handleLoadComplete },
    );

    for await (const event of iterable) {
      // Legacy seams never call onLoadComplete — any event implies the
      // model is loaded and generating.
      if (!loadFinished) handleLoadComplete();
      if (event.kind === 'token') {
        if (firstTokenAt === null) {
          firstTokenAt = now();
          pushDiagEvent('first-token');
        }
        tokensReceived++;
        if (event.text.trim().length > 0) visibleTextTokens++;
        if (tokensReceived >= SMOKE_MAX_TOKENS) {
          internal.abort();
          break;
        }
      } else if (event.kind === 'done') {
        workerCompletionTokens = event.completionTokens ?? 0;
        pushDiagEvent('generation-complete',
          `completionTokens=${workerCompletionTokens} visibleTokens=${tokensReceived}`);
        break;
      } else if (event.kind === 'error') {
        errorReason = event.reason;
        pushDiagEvent('generation-fail', event.reason);
        break;
      }
    }
  } catch (err) {
    caughtError = err;
    errorReason = err instanceof Error ? err.message : String(err);
    // Distinguish load-phase throws from generation-phase throws.
    // If load-finish was emitted, the error came from the generation
    // iteration (for-await), not from the seam constructor.
    pushDiagEvent(loadFinished ? 'generation-fail' : 'load-fail', errorReason);
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', cancelOnExternal);
    activeSlots.delete(slot);
  }

  const durationMs = now() - startedAt;

  // Determine outcome (HON-5).
  //
  // A smoke passes only when the user would have seen real output: at least one
  // post-filter token carried a non-whitespace character. A reply that is
  // entirely a <think> block (all consumed by the filter chain) or pure
  // whitespace produced no usable answer, so it FAILS — even though the worker's
  // completionTokens is > 0.
  //
  // We used to pass the fully-filtered case as a courtesy to reasoning models,
  // but a correctly-working reasoning model emits its visible answer AFTER the
  // <think> block; that answer survives filtering and lands here as a visible
  // token, so the normal path already covers it. Only a think-ONLY reply hits
  // the blank case — and a model that says nothing the user can see is not a
  // passing model, latent today but Sev1/2 the day a think-prefill model graduates.
  const hasVisibleTokens = visibleTextTokens > 0;
  const generationSucceeded = hasVisibleTokens && !errorReason;

  let result: SmokeResult;
  if (generationSucceeded) {
    result = {
      passed: true,
      // hasVisibleTokens ⇒ firstTokenAt is set, so this is a real measurement.
      firstTokenMs: firstTokenAt !== null ? firstTokenAt - startedAt : 0,
      durationMs,
      tokensReceived,
    };
  } else if (internal.signal.aborted && externalSignal?.aborted) {
    result = { passed: false, reason: 'Smoke cancelled', durationMs };
  } else if (internal.signal.aborted && firstTokenAt === null) {
    result = { passed: false, reason: 'Smoke timed out before any token', durationMs };
  } else {
    result = {
      passed: false,
      reason: errorReason ?? 'Smoke produced no tokens',
      durationMs,
    };
  }

  // Record diagnostic (in finally-equivalent position — after result is determined)
  if (!options?.skipDiagnostics) {
    try {
      const diagnostic = await buildDiagnostic({
        model,
        result,
        startedAt,
        durationMs,
        firstTokenAt,
        tokensReceived,
        caughtError,
        webgpuState,
        cacheState,
        diagEvents,
      });
      recordDiagnostic(diagnostic);
    } catch {
      // Never let diagnostic recording break smoke. Best-effort.
    }
  }

  return result;
}

/** Test-only: clear all active flags and generation seam. */
export function _resetSmokeForTesting(): void {
  activeSlots.clear();
  generationFn = null;
}

// ─── Diagnostic helpers ───────────────────────────────────────────────────

/** Safe performance.now() with fallback. */
function perfNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Delegates to `device/profile.ts` probeWebGPUAdapter (Invariant 5) and
 * enriches with a diagnostic event.
 */
async function probeWebGPU(
  pushEvent: (phase: DiagnosticPhase, note?: string) => void,
): Promise<WebGPUAdapterProbe> {
  const state = await probeWebGPUAdapter();

  if (!state.available) {
    pushEvent('webgpu-probe', 'WebGPU API not available');
  } else if (state.adapterError) {
    pushEvent('webgpu-probe', `error: ${state.adapterError}`);
  } else if (!state.adapterRequested || !state.features) {
    pushEvent('webgpu-probe', 'requestAdapter returned null');
  } else {
    pushEvent(
      'webgpu-probe',
      `features=${state.features.length} limits=${Object.keys(state.limits ?? {}).length}`,
    );
  }

  return state;
}

type CacheProbeResult = {
  hit: boolean;
  fileCount?: number;
  sizeBytes?: number;
  /** Last path segments of cached URLs. Capped at 20 entries to avoid log bloat. */
  files?: string[];
  probedAt: string;
};

async function probeCache(
  model: ModelConfig,
  pushEvent: (phase: DiagnosticPhase, note?: string) => void,
): Promise<CacheProbeResult | null> {
  try {
    if (typeof caches === 'undefined') {
      pushEvent('cache-probe', 'Cache API not available');
      return null;
    }

    const cacheName = `eco-local-ai-${model.id.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const hasCache = await caches.has(cacheName);

    if (!hasCache) {
      pushEvent('cache-probe', `miss: no cache "${cacheName}"`);
      return { hit: false, probedAt: new Date().toISOString() };
    }

    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    let totalSize = 0;
    const fileNames: string[] = [];
    const MAX_FILE_NAMES = 20;
    for (const req of keys) {
      // Extract last path segment as a human-readable file name.
      if (fileNames.length < MAX_FILE_NAMES) {
        try {
          const url = new URL(req.url);
          const segments = url.pathname.split('/').filter(Boolean);
          fileNames.push(segments[segments.length - 1] ?? req.url);
        } catch {
          fileNames.push(req.url);
        }
      }
      const resp = await cache.match(req);
      if (resp) {
        const sizeHeader = resp.headers.get('x-eco-cache-size-bytes');
        if (sizeHeader) {
          const parsed = parseInt(sizeHeader, 10);
          if (Number.isFinite(parsed)) totalSize += parsed;
        }
      }
    }

    const fileList = fileNames.length > 0
      ? ` (${fileNames.join(', ')})`
      : '';
    pushEvent('cache-probe', `hit: ${keys.length} files${fileList}, ${totalSize} bytes`);
    return {
      hit: keys.length > 0,
      fileCount: keys.length,
      sizeBytes: totalSize,
      files: fileNames.length > 0 ? fileNames : undefined,
      probedAt: new Date().toISOString(),
    };
  } catch (err) {
    pushEvent('cache-probe', `error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function getProfileKey(): string {
  try {
    const profile = getDeviceProfile();
    return profileKey(profile);
  } catch {
    return 'unknown';
  }
}

/**
 * The execution provider the active adapter resolved to. Smoke runs AFTER the
 * load, so the active adapter is the model under test — its `.backend` is the
 * resolved EP (a webgpu request that fell back to wasm reads as 'wasm' here).
 * Never throws; unknown reads as null.
 */
function getResolvedBackend(): RuntimeBackend | null {
  try {
    return getActiveAdapter()?.backend ?? null;
  } catch {
    return null;
  }
}

function getRuntimeAdapter(model: ModelConfig): 'transformers' | 'litert' | 'webllm' | 'unknown' {
  if (model.runtime === 'transformers') return 'transformers';
  if (model.runtime === 'litert') return 'litert';
  if (model.runtime === 'webllm') return 'webllm';
  return 'unknown';
}

function inspectError(err: unknown): { message: string; name?: string; stack?: string } | null {
  if (err == null) return null;
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
      stack: err.stack,
    };
  }
  return { message: String(err) };
}

async function buildDiagnostic(ctx: {
  model: ModelConfig;
  result: SmokeResult;
  startedAt: number;
  durationMs: number;
  firstTokenAt: number | null;
  tokensReceived: number;
  caughtError: unknown;
  webgpuState: WebGPUAdapterProbe;
  cacheState: CacheProbeResult | null;
  diagEvents: { at: number; phase: DiagnosticPhase; note?: string }[];
}): Promise<LocalAiDiagnostic> {
  const loadFinishEvent = ctx.diagEvents.find((e) => e.phase === 'load-finish');
  const loadStartEvent = ctx.diagEvents.find((e) => e.phase === 'load-start');

  let loadMs: number | null = null;
  if (loadFinishEvent && loadStartEvent) {
    loadMs = loadFinishEvent.at - loadStartEvent.at;
  }

  return {
    schemaVersion: 2,
    recordedAt: new Date().toISOString(),
    modelId: ctx.model.id,
    profileKey: getProfileKey(),
    runtimeAdapter: getRuntimeAdapter(ctx.model),
    resolvedBackend: getResolvedBackend(),
    outcome: ctx.result.passed ? 'smoke-pass' : 'smoke-fail',
    durations: {
      loadMs,
      firstTokenMs: ctx.result.passed ? ctx.result.firstTokenMs : null,
      totalMs: ctx.durationMs,
    },
    tokensReceived: ctx.tokensReceived,
    error: ctx.result.passed ? null : inspectError(ctx.caughtError) ?? (
      'reason' in ctx.result ? { message: ctx.result.reason } : null
    ),
    webgpu: ctx.webgpuState,
    cache: ctx.cacheState,
    env: await getDiagnosticEnv(),
    events: ctx.diagEvents,
  };
}
