// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Device profile — SINGLE SOURCE OF TRUTH for device detection.
 *
 * This module owns every reference to `navigator.gpu`, `navigator.deviceMemory`,
 * `navigator.userAgent`, and the `?eco-force-*` URL-param overrides inside the
 * `local-ai/` subtree. Other modules in `local-ai/` MUST go through
 * `getDeviceProfile()` rather than touching the navigator APIs directly.
 *
 * This is invariant 5 from `docs/design/2026-05-16/vision-and-architecture.md`.
 * The recommendation engine and lifecycle are the primary downstream consumers.
 *
 * URL-param overrides honored (must match the legacy `validation-harness.ts`
 * param names so existing test harnesses keep working — see
 * `apps/web/src/lib/validation-harness.ts`):
 *
 *   ?eco-force-capability=webgpu|wasm|unsupported   → webgpuSupport
 *   ?eco-force-browser=chromium|safari|firefox|mobile|unknown → browserClass
 *   ?eco-force-platform=desktop|mobile|tablet|unknown → isMobile
 *   ?eco-force-device-memory=<number>               → deviceMemoryGB
 *   ?eco-force-shader-f16=on|off                    → webgpuShaderF16 (setup probe only)
 *   ?eco-force-wasm=1|on                            → WASM/CPU execution provider (readForcedWasm)
 */

import type { DeviceProfile, BrowserClass, WebGPUSupport } from '../types';
import { isOrtArtifact, type OrtArtifact } from '../runtime/ort-artifact';

const URL_PARAM_FORCE_CAPABILITY = 'eco-force-capability';
const URL_PARAM_FORCE_BROWSER = 'eco-force-browser';
const URL_PARAM_FORCE_PLATFORM = 'eco-force-platform';
const URL_PARAM_FORCE_DEVICE_MEMORY = 'eco-force-device-memory';
const URL_PARAM_FORCE_SHADER_F16 = 'eco-force-shader-f16';
const URL_PARAM_FORCE_WASM = 'eco-force-wasm';
const URL_PARAM_FORCE_ORT_ARTIFACT = 'eco-force-ort-artifact';
const URL_PARAM_FORCE_THREADS = 'eco-force-threads';
const URL_PARAM_FORCE_ORT_ARENA = 'eco-force-ort-arena';
const URL_PARAM_FORCE_ORT_MEM_PATTERN = 'eco-force-ort-mem-pattern';
const URL_PARAM_FORCE_ORT_GRAPH_OPT = 'eco-force-ort-graph-opt';

// Tiny WASM module that uses the `v128.const` SIMD opcode. If
// `WebAssembly.validate` accepts these bytes, the runtime supports SIMD —
// which is the practical floor for running Transformers.js in WASM mode.
const WASM_SIMD_PROBE_BYTES: ReadonlyArray<number> = [
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
  10, 10, 1, 8, 0, 65, 0, 253, 15, 26, 11,
];

const SSR_FALLBACK: DeviceProfile = Object.freeze({
  browserClass: 'unknown' as const,
  webgpuSupport: 'none' as const,
  deviceMemoryGB: 0,
  isMobile: false,
  override: 'auto' as const,
});

export function getDeviceProfile(): DeviceProfile {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return SSR_FALLBACK;
  }

  const urlParams = readUrlParamsSafe();
  let override: DeviceProfile['override'] = 'auto';

  const forcedBrowser = urlParams.get(URL_PARAM_FORCE_BROWSER);
  let browserClass: BrowserClass;
  if (forcedBrowser && isBrowserClass(forcedBrowser)) {
    browserClass = forcedBrowser;
    override = 'user';
  } else {
    browserClass = detectBrowserClass(navigator.userAgent);
  }

  const forcedCapability = urlParams.get(URL_PARAM_FORCE_CAPABILITY);
  let webgpuSupport: WebGPUSupport;
  if (forcedCapability === 'webgpu') {
    webgpuSupport = 'webgpu';
    override = 'user';
  } else if (forcedCapability === 'wasm') {
    webgpuSupport = 'wasm-only';
    override = 'user';
  } else if (forcedCapability === 'unsupported') {
    webgpuSupport = 'none';
    override = 'user';
  } else {
    webgpuSupport = detectWebgpuSupport();
  }

  const forcedMemory = urlParams.get(URL_PARAM_FORCE_DEVICE_MEMORY);
  let deviceMemoryGB: number;
  const parsedForcedMemory = forcedMemory === null ? Number.NaN : Number(forcedMemory);
  if (Number.isFinite(parsedForcedMemory) && parsedForcedMemory >= 0) {
    deviceMemoryGB = parsedForcedMemory;
    override = 'user';
  } else {
    const reported = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    deviceMemoryGB = typeof reported === 'number' && reported >= 0 ? reported : 0;
  }

  const forcedPlatform = urlParams.get(URL_PARAM_FORCE_PLATFORM);
  let isMobile: boolean;
  if (forcedPlatform === 'mobile' || forcedPlatform === 'tablet') {
    isMobile = true;
    override = 'user';
  } else if (forcedPlatform === 'desktop' || forcedPlatform === 'unknown') {
    isMobile = false;
    override = 'user';
  } else {
    isMobile = detectIsMobile(navigator.userAgent);
  }

  // Once setup's async adapter probe has run, prefer its verdict: the
  // webgpuSupport computed above is optimistic ('gpu' in navigator) and never
  // knows shader-f16. Merging the probe lets every sync surface filter f16
  // models on an adapter that lacks shader-f16 (and downgrade a device whose
  // adapter doesn't actually work). The probe honors the same ?eco-force-*
  // overrides, so forced values stay consistent.
  if (probedCapability) {
    return {
      browserClass,
      webgpuSupport: probedCapability.support,
      webgpuShaderF16: probedCapability.shaderF16,
      deviceMemoryGB,
      isMobile,
      override,
    };
  }

  return {
    browserClass,
    webgpuSupport,
    deviceMemoryGB,
    isMobile,
    override,
  };
}

/**
 * Logical CPU core count (`navigator.hardwareConcurrency`), centralized here
 * for Invariant 5. Returns `null` when unavailable (SSR, or a browser that
 * doesn't expose it). A low count is a strong "weak device" signal — used to
 * widen the cold-load smoke budget so a slow-but-working load on modest
 * hardware isn't false-aborted.
 */
export function getHardwareConcurrency(): number | null {
  if (typeof navigator === 'undefined') return null;
  const n = navigator.hardwareConcurrency;
  return typeof n === 'number' && n > 0 ? n : null;
}

/**
 * Human-readable device/browser label for the below-floor screen — or
 * `undefined` to keep the generic "your browser" copy.
 *
 * This is a pure function: it takes a `DeviceProfile` (never touches
 * `navigator`) so it stays Invariant-5-safe and trivially testable. The
 * label must be HONEST — we only name a browser when the below-floor result
 * is genuinely a browser-support gap. A below-floor *Chromium* device is
 * almost always a memory/hardware limit, not a browser problem, so naming
 * "Chrome" there would mislead the user; we return `undefined` and let the
 * generic copy stand.
 */
export function describeDevice(profile: DeviceProfile): string | undefined {
  switch (profile.browserClass) {
    case 'safari':
      return profile.isMobile ? 'Safari on iPhone or iPad' : 'Safari';
    case 'firefox':
      return profile.isMobile ? 'Firefox on mobile' : 'Firefox';
    case 'mobile':
      return 'your mobile browser';
    case 'chromium':
    case 'unknown':
    default:
      return undefined;
  }
}

function readUrlParamsSafe(): URLSearchParams {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
}

function isBrowserClass(value: string): value is BrowserClass {
  return (
    value === 'chromium'
    || value === 'safari'
    || value === 'firefox'
    || value === 'mobile'
    || value === 'unknown'
  );
}

function detectBrowserClass(userAgent: string): BrowserClass {
  const ua = userAgent.toLowerCase();
  if (ua.includes('firefox')) return 'firefox';
  if (
    ua.includes('chrome')
    || ua.includes('chromium')
    || ua.includes('edg/')
  ) {
    return 'chromium';
  }
  if (
    ua.includes('safari')
    && !ua.includes('chrome')
    && !ua.includes('chromium')
  ) {
    return 'safari';
  }
  if (/iphone|ipad|android|mobile|tablet/.test(ua)) {
    return 'mobile';
  }
  return 'unknown';
}

function detectIsMobile(userAgent: string): boolean {
  return /iphone|ipad|android|mobile|tablet/i.test(userAgent);
}

const PROBE_TIMEOUT_MS = 4_000;

/** WASM execution tier when WebGPU is unavailable. SIMD is the practical floor. */
function detectWasmTier(): 'wasm-only' | 'none' {
  if (typeof WebAssembly === 'undefined') return 'none';
  if (typeof WebAssembly.validate !== 'function') return 'none';
  try {
    const bytes = new Uint8Array(WASM_SIMD_PROBE_BYTES);
    if (WebAssembly.validate(bytes)) return 'wasm-only';
  } catch {
    // fall through
  }
  return 'none';
}

/** Forced ?eco-force-capability override, or null when absent/invalid. */
function readForcedCapability(): WebGPUSupport | null {
  const v = readUrlParamsSafe().get(URL_PARAM_FORCE_CAPABILITY);
  if (v === 'webgpu') return 'webgpu';
  if (v === 'wasm') return 'wasm-only';
  if (v === 'unsupported') return 'none';
  return null;
}

/** Forced ?eco-force-shader-f16=on|off override, or null when absent/invalid. */
function readForcedShaderF16(): boolean | null {
  const v = readUrlParamsSafe().get(URL_PARAM_FORCE_SHADER_F16);
  if (v === 'on') return true;
  if (v === 'off') return false;
  return null;
}

/**
 * Forced ?eco-force-wasm override (bare flag, `=1`, `=on`, or `=true`) —
 * routes the Transformers.js runtime to the WASM/CPU execution provider even
 * when WebGPU exists. Diagnostics tooling for verifying the CPU path on any
 * device; the transformers adapter reads this at load time so the flag
 * crosses the worker boundary via the init message (the worker itself never
 * reads URL params). Applies to the Transformers.js runtime ONLY — WebLLM and
 * LiteRT have no CPU path, so the flag is a no-op for their models.
 */
export function readForcedWasm(): boolean {
  const v = readUrlParamsSafe().get(URL_PARAM_FORCE_WASM);
  // '' = bare `?eco-force-wasm` (URLSearchParams returns '' for a valueless
  // param, null when absent) — a natural debug-URL shorthand, treated as on.
  return v === '' || v === '1' || v === 'on' || v === 'true';
}

/**
 * Forced ?eco-force-ort-artifact=standard|asyncify|jspi override, or null when
 * absent/invalid — selects which onnxruntime-web WASM artifact the Transformers.js
 * runtime loads (see runtime/ort-artifact.ts). Measurement tooling for the
 * per-device serving matrix: the adapter reads this at load time and threads it
 * across the worker boundary via the init message (the worker never reads URL
 * params). A non-asyncify artifact removes the WebGPU/JSEP kernels, so it is only
 * meaningful on the WASM EP (pair with ?eco-force-wasm). No-op for LiteRT/WebLLM.
 */
export function readForcedOrtArtifact(): OrtArtifact | null {
  const v = readUrlParamsSafe().get(URL_PARAM_FORCE_ORT_ARTIFACT);
  return isOrtArtifact(v) ? v : null;
}

/**
 * Forced ?eco-force-threads=N override, or null when absent/invalid — sets the
 * onnxruntime-web WASM thread-pool size (`env.wasm.numThreads`). Only a positive
 * integer is honored; the worker clamps to hardwareConcurrency. Threading needs
 * cross-origin isolation (ort falls back to 1 without it). Measurement lever for
 * the serving matrix; applies to the Transformers.js WASM path only.
 */
export function readForcedThreads(): number | null {
  const v = readUrlParamsSafe().get(URL_PARAM_FORCE_THREADS);
  if (v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * ORT graph-optimization levels accepted by `?eco-force-ort-graph-opt` — the
 * onnxruntime-common `graphOptimizationLevel` session-option values.
 */
export type OrtGraphOptLevel = 'disabled' | 'basic' | 'extended' | 'all';
const ORT_GRAPH_OPT_LEVELS: readonly OrtGraphOptLevel[] = ['disabled', 'basic', 'extended', 'all'];

/**
 * Forced ?eco-force-ort-arena=on|off override, or null when absent/invalid —
 * sets ORT's `enableCpuMemArena` session option (A-3 measurement lever: the
 * BFC-style arena's growth policy is a load-peak suspect). Absent ⇒ the worker
 * passes no session_options and ORT's default stands. WASM-EP measurement
 * lever only; no-op for LiteRT/WebLLM.
 */
export function readForcedOrtArena(): boolean | null {
  return readOnOffParam(URL_PARAM_FORCE_ORT_ARENA);
}

/**
 * Forced ?eco-force-ort-mem-pattern=on|off override, or null when absent/invalid —
 * sets ORT's `enableMemPattern` session option (A-3 measurement lever: memory
 * patterns pre-plan/pre-allocate activation buffers at session init). Same
 * default-untouched semantics as the arena lever.
 */
export function readForcedOrtMemPattern(): boolean | null {
  return readOnOffParam(URL_PARAM_FORCE_ORT_MEM_PATTERN);
}

/**
 * Forced ?eco-force-ort-graph-opt=disabled|basic|extended|all override, or null
 * when absent/invalid — sets ORT's `graphOptimizationLevel` session option.
 * A-3 measurement lever: constant folding at higher levels can MATERIALIZE
 * fp32 copies of fp16 initializers during session init (the prime load-spike
 * suspect for q4f16-on-CPU-EP), so comparing levels isolates that cost.
 */
export function readForcedOrtGraphOpt(): OrtGraphOptLevel | null {
  const v = readUrlParamsSafe().get(URL_PARAM_FORCE_ORT_GRAPH_OPT);
  return (ORT_GRAPH_OPT_LEVELS as readonly string[]).includes(v ?? '')
    ? (v as OrtGraphOptLevel)
    : null;
}

/** Shared on|off param shape (mirrors readForcedShaderF16's strictness). */
function readOnOffParam(param: string): boolean | null {
  const v = readUrlParamsSafe().get(param);
  if (v === 'on') return true;
  if (v === 'off') return false;
  return null;
}

function detectWebgpuSupport(): WebGPUSupport {
  if ('gpu' in navigator) {
    return 'webgpu';
  }
  return detectWasmTier();
}

/** WebGPU capability for the setup decision: tier + shader-f16 presence. */
type WebgpuCapability = {
  support: WebGPUSupport;
  /** Adapter exposes the `shader-f16` feature. Only meaningful when support is 'webgpu'. */
  shaderF16?: boolean;
};

/**
 * Module-level cache of the async adapter-probe verdict.
 *
 * `probeWebgpuCapability()` (run by the setup flow on every load) is the ONLY
 * code that learns whether the adapter exposes `shader-f16` and whether a
 * working adapter exists at all. The sync `getDeviceProfile()` — which every UI
 * surface uses (the chat + Settings model pickers, self-heal) — otherwise only
 * has the optimistic `'gpu' in navigator` guess and NEVER knows `shader-f16`,
 * so those surfaces offer f16 models on adapters that can't run them. Caching
 * the probe verdict lets `getDeviceProfile()` reflect the real adapter. `null`
 * until the first probe completes this session.
 */
let probedCapability: WebgpuCapability | null = null;

/** Test seam: clear the cached adapter-probe verdict between cases. */
export function resetProbedWebgpuCapability(): void {
  probedCapability = null;
  notifyDeviceProfileChanged();
}

// ─── Reactive device-profile store ────────────────────────────────────────
//
// The async adapter probe (probeWebgpuCapability) learns the device's REAL
// capability — `shader-f16` presence and whether a working adapter exists at
// all — only AFTER the first paint. `getDeviceProfile()` merges that verdict
// once it's cached, but a React surface that read the profile inside a frozen
// `useMemo` never recomputed when the verdict landed, so f16-less devices kept
// being offered f16 models they can't run until some unrelated re-render. This
// tiny observer lets every surface subscribe via `useSyncExternalStore` and
// recompute the instant the probe resolves — one mechanism for all surfaces,
// no per-component async wiring. Framework-agnostic (no React import); the
// thin React hook lives in `hooks/local-ai/useDeviceProfile.ts`.

const deviceProfileListeners = new Set<() => void>();

/**
 * Last value-stable snapshot. `getDeviceProfileSnapshot()` must return a
 * referentially-stable object while the value is unchanged — `useSyncExternalStore`
 * re-renders forever if `getSnapshot` returns a fresh object every call.
 */
let deviceProfileSnapshot: DeviceProfile | null = null;

function deviceProfileEquals(a: DeviceProfile, b: DeviceProfile): boolean {
  return (
    a.browserClass === b.browserClass
    && a.webgpuSupport === b.webgpuSupport
    && a.deviceMemoryGB === b.deviceMemoryGB
    && a.isMobile === b.isMobile
    && a.override === b.override
    && a.webgpuShaderF16 === b.webgpuShaderF16
  );
}

/**
 * Subscribe to device-profile changes (fires when the adapter probe lands, or
 * when the test seam resets it). Returns an unsubscribe. For useSyncExternalStore.
 */
export function subscribeDeviceProfile(listener: () => void): () => void {
  deviceProfileListeners.add(listener);
  return () => {
    deviceProfileListeners.delete(listener);
  };
}

/**
 * Client snapshot for useSyncExternalStore. Recomputes `getDeviceProfile()`
 * each call (cheap — a few navigator reads + a URLSearchParams parse) but
 * reuses the cached object reference while the value is unchanged, so React
 * never loops. The reference only changes when the profile genuinely changes
 * (the probe verdict landing), which is exactly when surfaces should re-render.
 */
export function getDeviceProfileSnapshot(): DeviceProfile {
  const next = getDeviceProfile();
  if (deviceProfileSnapshot && deviceProfileEquals(deviceProfileSnapshot, next)) {
    return deviceProfileSnapshot;
  }
  deviceProfileSnapshot = next;
  return next;
}

/**
 * Server snapshot for useSyncExternalStore — the stable frozen SSR fallback so
 * the hydration render matches the server HTML. After hydration React re-reads
 * the client snapshot and re-renders with the real profile if it differs (the
 * sanctioned useSyncExternalStore pattern; no hydration mismatch).
 */
export function getServerDeviceProfileSnapshot(): DeviceProfile {
  return SSR_FALLBACK;
}

function notifyDeviceProfileChanged(): void {
  for (const listener of deviceProfileListeners) {
    listener();
  }
}

/**
 * Adapter-aware WebGPU capability for the SETUP decision.
 *
 * `detectWebgpuSupport()` is optimistic — it returns 'webgpu' whenever
 * `'gpu' in navigator`, without ever requesting an adapter. A device that
 * exposes the API but has no working adapter (blocklisted driver, weak iGPU)
 * would then be handed a WebGPU model that fails at load. This probe actually
 * calls `requestAdapter()` so the recommendation reflects reality — and reads
 * `adapter.features` for `shader-f16`, which every f16 catalog build needs on
 * the WebGPU EP (an adapter without it loads the model then dies on the first
 * f16 op — observed on Chrome 149 / Windows iGPU).
 *
 * Never throws. A hang is bounded by PROBE_TIMEOUT_MS, after which we fall
 * back to the optimistic sync verdict (no worse than today's behavior).
 */
async function probeWebgpuCapability(): Promise<WebgpuCapability> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { support: 'none' };
  }

  let support: WebGPUSupport;
  let shaderF16: boolean | undefined;

  const forced = readForcedCapability();
  if (forced) {
    support = forced;
  } else if (!('gpu' in navigator)) {
    support = detectWasmTier();
  } else {
    try {
      const gpu = navigator.gpu as GPU;
      const timeout = new Promise<'timeout'>((resolve) => {
        setTimeout(() => {
          resolve('timeout');
        }, PROBE_TIMEOUT_MS);
      });
      const adapter = await Promise.race([gpu.requestAdapter(), timeout]);
      if (adapter === 'timeout') {
        support = detectWebgpuSupport();
      } else if (adapter) {
        support = 'webgpu';
        shaderF16 = adapter.features.has('shader-f16');
      } else {
        support = detectWasmTier();
      }
    } catch {
      support = detectWasmTier();
    }
  }

  // shader-f16 only matters on the WebGPU EP. The ?eco-force-shader-f16
  // override lets us reproduce an f16-less adapter on any machine (the Mac
  // always has shader-f16) — needed to verify the f16-less path locally and on
  // Cam's PC via the preview.
  if (support === 'webgpu') {
    const forcedF16 = readForcedShaderF16();
    if (forcedF16 !== null) shaderF16 = forcedF16;
  } else {
    shaderF16 = undefined;
  }

  // Cache the verdict so the sync getDeviceProfile() (used by every UI surface)
  // can reflect the real adapter capability, not just the optimistic guess —
  // then notify reactive subscribers so the chat picker, the "Recommended" tag,
  // and the Settings dialog recompute the instant the verdict lands.
  probedCapability = { support, shaderF16 };
  notifyDeviceProfileChanged();
  return probedCapability;
}

/** Adapter-aware WebGPU tier for the setup decision (capability tier only). */
export async function probeWebgpuSupport(): Promise<WebGPUSupport> {
  return (await probeWebgpuCapability()).support;
}

/**
 * Device profile for the SETUP path only: the sync profile with
 * `webgpuSupport` replaced by the adapter-probed value. Awaited solely by
 * the setup orchestrator; every other caller keeps the sync getDeviceProfile().
 */
export async function resolveSetupProfile(): Promise<DeviceProfile> {
  const base = getDeviceProfile();
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return base;
  }
  const { support, shaderF16 } = await probeWebgpuCapability();
  return { ...base, webgpuSupport: support, webgpuShaderF16: shaderF16 };
}

// ─── Diagnostic helpers (Invariant 5 safe) ───────────────────────────────

/**
 * Environment snapshot for diagnostic capture. All navigator access is
 * centralized here so other local-ai/ modules satisfy Invariant 5.
 *
 * High-entropy UA fields (architecture, platform, platformVersion, model,
 * bitness) are resolved via `navigator.userAgentData.getHighEntropyValues`
 * when available (Chromium-based browsers). This avoids UA spoofing that
 * reports Apple Silicon as Intel.
 */
export type DiagnosticEnv = {
  userAgent: string;
  deviceMemoryGB: number | null;
  hardwareConcurrency: number | null;
  /** CPU architecture from UA Client Hints — e.g. "arm" or "x86". */
  architecture?: string;
  /** OS platform from UA Client Hints — e.g. "macOS", "Windows". */
  platform?: string;
  /** OS version from UA Client Hints — e.g. "15.5.0". */
  platformVersion?: string;
  /** Device model from UA Client Hints (usually empty on desktop). */
  uaModel?: string;
  /** CPU bitness from UA Client Hints — e.g. "64". */
  bitness?: string;
};

/**
 * Chromium's NavigatorUAData shape (not in all TS libs). Narrowed to only
 * what we use so we don't depend on an external type package.
 */
type NavigatorUAData = {
  getHighEntropyValues: (
    hints: string[],
  ) => Promise<{
    architecture?: string;
    platform?: string;
    platformVersion?: string;
    model?: string;
    bitness?: string;
  }>;
};

export async function getDiagnosticEnv(): Promise<DiagnosticEnv> {
  if (typeof navigator === 'undefined') {
    return { userAgent: 'unknown', deviceMemoryGB: null, hardwareConcurrency: null };
  }
  const reported = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const env: DiagnosticEnv = {
    userAgent: navigator.userAgent,
    deviceMemoryGB: typeof reported === 'number' && reported >= 0 ? reported : null,
    hardwareConcurrency:
      typeof navigator.hardwareConcurrency === 'number'
        ? navigator.hardwareConcurrency
        : null,
  };

  // Resolve high-entropy values when the UA Client Hints API is available
  // (Chromium-based). This reveals the real CPU architecture even when Chrome
  // spoofs the UA string to "Intel Mac OS X 10_15_7" on Apple Silicon.
  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData }).userAgentData;
  if (uaData && typeof uaData.getHighEntropyValues === 'function') {
    try {
      const hints = await uaData.getHighEntropyValues([
        'architecture',
        'platform',
        'platformVersion',
        'model',
        'bitness',
      ]);
      if (hints.architecture) env.architecture = hints.architecture;
      if (hints.platform) env.platform = hints.platform;
      if (hints.platformVersion) env.platformVersion = hints.platformVersion;
      if (hints.model) env.uaModel = hints.model;
      if (hints.bitness) env.bitness = hints.bitness;
    } catch {
      // Best-effort — some browsers may reject the promise. Env fields
      // remain undefined, which is fine.
    }
  }

  return env;
}

/**
 * True when the WebGPU API object exists on this device — a synchronous
 * presence check, no adapter request. For callers that must record "was WebGPU
 * even on the table" without paying an async probe (e.g. the sustained probe's
 * crash-evidence marker, written before a load that may kill the tab).
 * Presence ≠ usable: `probeWebGPUAdapter` is the real capability check.
 */
export function hasWebGpuApi(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/**
 * Probe the WebGPU adapter for diagnostic purposes. Returns adapter
 * availability, features, and selected GPU limits. Never throws.
 *
 * All `navigator.gpu` access in the local-ai/ subtree MUST go through
 * this function, `hasWebGpuApi`, or `getDeviceProfile()` (Invariant 5).
 */
export type WebGPUAdapterProbe = {
  available: boolean;
  adapterRequested: boolean;
  adapterError?: string;
  features?: string[];
  limits?: Record<string, number>;
};

export async function probeWebGPUAdapter(): Promise<WebGPUAdapterProbe> {
  const state: WebGPUAdapterProbe = {
    available: false,
    adapterRequested: false,
  };

  try {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      return state;
    }

    state.available = true;

    const gpu = navigator.gpu as GPU;
    state.adapterRequested = true;
    const adapter = await gpu.requestAdapter();

    if (!adapter) {
      return state;
    }

    state.features = Array.from(adapter.features);
    const limitsObj: Record<string, number> = {};
    const limitKeys = [
      'maxTextureDimension1D',
      'maxTextureDimension2D',
      'maxTextureDimension3D',
      'maxTextureArrayLayers',
      'maxBindGroups',
      'maxBufferSize',
      'maxStorageBufferBindingSize',
      'maxUniformBufferBindingSize',
    ] as const;
    for (const key of limitKeys) {
      const val = (adapter.limits as unknown as Record<string, unknown>)[key];
      if (typeof val === 'number') {
        limitsObj[key] = val;
      }
    }
    state.limits = limitsObj;
  } catch (err) {
    state.adapterError = err instanceof Error ? err.message : String(err);
  }

  return state;
}
