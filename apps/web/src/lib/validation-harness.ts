// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Mission-owned browser validation harness.
 *
 * This module exposes non-production-only URL seams that browser validators can
 * use on the local mission stack. The harness is enabled only when the mission
 * services opt in via NEXT_PUBLIC_ECO_VALIDATION_HARNESS or while running tests.
 */

// Types imported from dependency-free leaf modules, not from
// `inference-capability.ts` / `local-heavy-work-owner.ts` — both of those
// import this harness at runtime, so naming their types here would re-form the
// type-only import cycle that `scripts/check-circular-deps.mjs` rejects.
import type { InferenceCapability } from './inference-capability-types';
import { getCatalog, getModel } from '../local-ai/catalog/catalog';
import { getEvalCandidateModel } from '../local-ai/eval/eval-candidates';
import type { Slot } from '../local-ai/types';
import { getGenerationProfile, type ChatIntent } from './chat-intent';
import type { LocalHeavyWorkKind } from './local-heavy-work-types';
import { safeStorage } from './local-storage';

/** Inlined from the now-deleted lib/local-device-policy.ts. */
type LocalDeviceBrowserClass = 'chromium' | 'safari' | 'firefox' | 'unknown';
type LocalDevicePlatformClass = 'desktop' | 'mobile' | 'tablet' | 'unknown';

export type ValidationDownloadFailureMode =
  | 'none'
  | 'storage'
  | 'cache'
  | 'opfs'
  | 'quota'
  | 'hosting';
export type ValidationRuntimeMode = 'none' | 'crash';
export type ValidationProtectionMode =
  | 'none'
  | 'battery-reduced'
  | 'battery-disabled'
  | 'thermal'
  | 'memory-pressure';
export type ValidationRemoteMode = 'none' | 'queue' | 'first-token';
export type ValidationLocalGenerationFixtureMode = 'none' | 'smoke-ready';
export type ValidationHeavyWorkDryRunMode = 'none' | LocalHeavyWorkKind;
export type ValidationSlotStatusOverride = 'empty' | 'preparing' | 'ready' | 'error';
export type ValidationSwapMode = 'none' | 'hold';

export type ValidationHarnessState = {
  enabled: boolean;
  downloadFailure: ValidationDownloadFailureMode;
  runtimeMode: ValidationRuntimeMode;
  protectionMode: ValidationProtectionMode;
  remoteMode: ValidationRemoteMode;
  heavyWorkDryRun: ValidationHeavyWorkDryRunMode;
};

export type ValidationLocalDeviceProfileOverride = {
  capability?: InferenceCapability;
  browserClass?: LocalDeviceBrowserClass;
  platformClass?: LocalDevicePlatformClass;
  deviceMemoryGB?: number | null;
  opfsAvailable?: boolean | null;
  dataSaverEnabled?: boolean | null;
  effectiveConnectionType?: string | null;
  meteredConnection?: boolean | null;
};

export type ValidationLocalGenerationFixture = {
  mode: Exclude<ValidationLocalGenerationFixtureMode, 'none'>;
  modelId: string;
  slot: 'eco-fast' | 'eco-smart';
  chunks: string[];
};

export type ValidationConversationHistoryFixture =
  | 'none'
  | 'assistant-dom'
  | 'hybrid-continuation'
  | 'clear';

export type ValidationProtectionBanner = {
  title: string;
  body: string;
  tone: 'warning' | 'notice';
};

export type ValidationSelectedModelBanner = ValidationProtectionBanner & {
  modelId: string;
  modelLabel: string;
  profileSummary: string;
};

export type ValidationHeavyWorkDryRun = {
  mode: Exclude<ValidationHeavyWorkDryRunMode, 'none'>;
  modelId: string;
  label: string;
};

export type ValidationHarnessEnvironment = {
  hostname?: string | null;
  nodeEnv?: string | null;
  explicitHarnessEnabled?: boolean;
};

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

export function isLoopbackHostname(hostname: string | null | undefined): boolean {
  if (!hostname) {
    return false;
  }

  const normalized = normalizeHost(hostname);
  return (
    normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized === '::ffff:127.0.0.1'
  );
}

export function isValidationHarnessEnabledForEnvironment({
  hostname,
  nodeEnv = process.env.NODE_ENV,
  explicitHarnessEnabled = process.env.NEXT_PUBLIC_ECO_VALIDATION_HARNESS === 'true',
}: ValidationHarnessEnvironment = {}): boolean {
  if (nodeEnv === 'test') {
    return true;
  }

  if (!hostname && nodeEnv !== 'production' && explicitHarnessEnabled) {
    return true;
  }

  const isLoopback = isLoopbackHostname(hostname);
  if (!isLoopback) {
    return false;
  }

  return nodeEnv !== 'production' || explicitHarnessEnabled;
}

function isLoopbackHost(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return isLoopbackHostname(window.location.hostname);
}

function readSearchParam(name: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

function readStorageParam(name: string): string | null {
  return safeStorage.get(name);
}

function readHarnessParam(name: string): string | null {
  return readSearchParam(name) ?? readStorageParam(name);
}

function normalizeDownloadFailure(value: string | null): ValidationDownloadFailureMode {
  switch (value) {
    case 'cache':
    case 'opfs':
    case 'quota':
    case 'storage':
    case 'hosting':
      return value;
    default:
      return 'none';
  }
}

function normalizeCapability(value: string | null): InferenceCapability | undefined {
  switch (value) {
    case 'webgpu':
    case 'wasm':
    case 'unsupported':
      return value;
    default:
      return undefined;
  }
}

function normalizeBrowserClass(value: string | null): LocalDeviceBrowserClass | undefined {
  switch (value) {
    case 'chromium':
    case 'safari':
    case 'firefox':
    case 'unknown':
      return value;
    default:
      return undefined;
  }
}

function normalizePlatformClass(value: string | null): LocalDevicePlatformClass | undefined {
  switch (value) {
    case 'desktop':
    case 'mobile':
    case 'tablet':
    case 'unknown':
      return value;
    default:
      return undefined;
  }
}

function normalizeBoolean(value: string | null): boolean | null | undefined {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function normalizeNumber(value: string | null): number | null | undefined {
  if (value === null) return undefined;
  if (value === 'null' || value === 'unknown') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeRuntimeMode(value: string | null): ValidationRuntimeMode {
  return value === 'crash' ? 'crash' : 'none';
}

function normalizeProtectionMode(value: string | null): ValidationProtectionMode {
  switch (value) {
    case 'battery-reduced':
    case 'battery-disabled':
    case 'thermal':
    case 'memory-pressure':
      return value;
    default:
      return 'none';
  }
}

function normalizeRemoteMode(value: string | null): ValidationRemoteMode {
  switch (value) {
    case 'queue':
    case 'first-token':
      return value;
    default:
      return 'none';
  }
}

function normalizeHeavyWorkDryRunMode(value: string | null): ValidationHeavyWorkDryRunMode {
  switch (value) {
    case 'benchmark':
    case 'download':
    case 'readiness':
    case 'generation':
      return value;
    default:
      return 'none';
  }
}

function normalizeLocalGenerationFixtureMode(
  value: string | null,
): ValidationLocalGenerationFixtureMode {
  return value === 'smoke-ready' ? 'smoke-ready' : 'none';
}

function normalizeSlotStatusOverride(value: string | null): ValidationSlotStatusOverride | null {
  switch (value) {
    case 'empty':
    case 'preparing':
    case 'ready':
    case 'error':
      return value;
    default:
      return null;
  }
}

function normalizeConversationHistoryFixture(
  value: string | null,
): ValidationConversationHistoryFixture {
  switch (value) {
    case 'assistant-dom':
    case 'hybrid-continuation':
    case 'clear':
      return value;
    default:
      return 'none';
  }
}

const VALIDATION_PROFILE_INTENTS: ChatIntent[] = ['quick', 'explain', 'deep'];

function formatProfileNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function formatValidationGenerationProfile(intent: ChatIntent, modelId: string): string {
  const profile = getGenerationProfile(intent, true, modelId, { allowValidationModel: true });
  const parts = [
    `${intent}: temp ${formatProfileNumber(profile.temperature)}`,
    `cap ${profile.maxTokens}`,
  ];

  if (profile.topP !== undefined) parts.push(`top_p ${formatProfileNumber(profile.topP)}`);
  if (profile.topK !== undefined) parts.push(`top_k ${profile.topK}`);
  if (profile.repetitionPenalty !== undefined) {
    parts.push(`repetition_penalty ${formatProfileNumber(profile.repetitionPenalty)}`);
  }
  if (profile.noRepeatNgramSize !== undefined) {
    parts.push(`no_repeat_ngram ${profile.noRepeatNgramSize}`);
  }

  return parts.join(' ');
}

export function isValidationHarnessEnabled(): boolean {
  if (
    process.env.NEXT_PUBLIC_ECO_VALIDATION_HARNESS === 'true'
    || process.env.NODE_ENV === 'test'
  ) {
    return isValidationHarnessEnabledForEnvironment({
      hostname: typeof window === 'undefined' ? null : window.location.hostname,
      nodeEnv: process.env.NODE_ENV,
      explicitHarnessEnabled: true,
    });
  }

  return isLoopbackHost() && process.env.NODE_ENV !== 'production';
}

export function getValidationHarnessState(): ValidationHarnessState {
  if (!isValidationHarnessEnabled()) {
    return {
      enabled: false,
      downloadFailure: 'none',
      runtimeMode: 'none',
      protectionMode: 'none',
      remoteMode: 'none',
      heavyWorkDryRun: 'none',
    };
  }

  return {
    enabled: true,
    downloadFailure: normalizeDownloadFailure(readHarnessParam('eco-force-download')),
    runtimeMode: normalizeRuntimeMode(readHarnessParam('eco-force-local-runtime')),
    protectionMode: normalizeProtectionMode(readHarnessParam('eco-force-protection')),
    remoteMode: normalizeRemoteMode(readHarnessParam('eco-force-remote')),
    heavyWorkDryRun: normalizeHeavyWorkDryRunMode(readHarnessParam('eco-heavy-work-dry-run')),
  };
}

export function getValidationHeavyWorkDryRun(): ValidationHeavyWorkDryRun | null {
  const { heavyWorkDryRun } = getValidationHarnessState();
  if (heavyWorkDryRun === 'none') {
    return null;
  }

  const modelId = readHarnessParam('eco-heavy-work-model') ?? 'local/qwen3-0.6b';
  const model = getModel(modelId);
  const label = model ? model.friendlyName : modelId;

  return {
    mode: heavyWorkDryRun,
    modelId,
    label,
  };
}

export function getValidationLocalDeviceProfileOverride(): ValidationLocalDeviceProfileOverride | null {
  if (!isValidationHarnessEnabled()) {
    return null;
  }

  const override: ValidationLocalDeviceProfileOverride = {};
  const capability = normalizeCapability(readHarnessParam('eco-force-capability'));
  const browserClass = normalizeBrowserClass(readHarnessParam('eco-force-browser'));
  const platformClass = normalizePlatformClass(readHarnessParam('eco-force-platform'));
  const deviceMemoryGB = normalizeNumber(readHarnessParam('eco-force-device-memory'));
  const opfsAvailable = normalizeBoolean(readHarnessParam('eco-force-opfs'));
  const dataSaverEnabled = normalizeBoolean(readHarnessParam('eco-force-data-saver'));
  const meteredConnection = normalizeBoolean(readHarnessParam('eco-force-metered'));
  const effectiveConnectionType = readHarnessParam('eco-force-connection');

  if (capability) override.capability = capability;
  if (browserClass) override.browserClass = browserClass;
  if (platformClass) override.platformClass = platformClass;
  if (deviceMemoryGB !== undefined) override.deviceMemoryGB = deviceMemoryGB;
  if (opfsAvailable !== undefined) override.opfsAvailable = opfsAvailable;
  if (dataSaverEnabled !== undefined) override.dataSaverEnabled = dataSaverEnabled;
  if (meteredConnection !== undefined) override.meteredConnection = meteredConnection;
  if (effectiveConnectionType) override.effectiveConnectionType = effectiveConnectionType;

  return Object.keys(override).length > 0 ? override : null;
}

export function getValidationConversationHistoryFixture(): ValidationConversationHistoryFixture {
  if (!isValidationHarnessEnabled()) {
    return 'none';
  }

  return normalizeConversationHistoryFixture(readHarnessParam('eco-history-fixture'));
}

/**
 * Model the local-generation fixture stands in for when the URL names none.
 * Read off the catalog (the everyday `eco-fast` pick) rather than pinned to an
 * id: this used to name `local/bonsai-1.7b-q1`, which retired from the catalog
 * in 2026-07, so `getModel()` returned null and the fixture rendered its raw id
 * instead of a friendly name. Dev-only surface — the harness is off in
 * production.
 */
function defaultLocalGenerationFixtureModelId(): string {
  const catalog = getCatalog();
  return catalog.find((model) => model.tier['eco-fast'] === 'capable')?.id
    ?? catalog[0]?.id
    ?? '';
}

export function getValidationLocalGenerationFixture(
  modelId?: string | null,
): ValidationLocalGenerationFixture | null {
  if (!isValidationHarnessEnabled()) {
    return null;
  }

  const mode = normalizeLocalGenerationFixtureMode(
    readHarnessParam('eco-local-generation-fixture'),
  );
  if (mode === 'none') {
    return null;
  }

  const fixtureModelId =
    readHarnessParam('eco-local-generation-model') ?? defaultLocalGenerationFixtureModelId();
  if (modelId && modelId !== fixtureModelId) {
    return null;
  }

  const fixtureSlot =
    readHarnessParam('eco-local-generation-slot') === 'eco-smart'
      ? 'eco-smart'
      : 'eco-fast';
  const fixtureSlotLabel = fixtureSlot === 'eco-smart' ? 'Eco Smart' : 'Eco Fast';
  const fixtureModel = getModel(fixtureModelId);
  const fixtureModelLabel = fixtureModel
    ? fixtureModel.friendlyName
    : fixtureModelId;

  return {
    mode,
    modelId: fixtureModelId,
    slot: fixtureSlot,
    chunks: [
      'local/fixture response: validation generation complete. ',
      `${fixtureSlotLabel} used ${fixtureModelLabel} through the browser-local fixture harness path; `,
      'no Eco Network prompt egress was needed. ',
      'This representative stream is intentionally chunked so validators can see and interrupt local generation. ',
      'Fixture complete.',
    ],
  };
}

export function getValidationSlotModelOverride(slot: Slot): string | null {
  if (!isValidationHarnessEnabled()) {
    return null;
  }

  const modelId = readHarnessParam(`eco-validation-slot-${slot}`);
  if (!modelId) {
    return null;
  }

  if (getModel(modelId) || getEvalCandidateModel(modelId)) {
    return modelId;
  }

  return null;
}

export function getValidationSelectedModelOverride(): string | null {
  if (!isValidationHarnessEnabled()) {
    return null;
  }

  const selectedModel = readHarnessParam('eco-validation-selected-model');
  if (!selectedModel) {
    return null;
  }

  if (selectedModel === 'auto' || selectedModel === 'eco-fast' || selectedModel === 'eco-smart') {
    return selectedModel;
  }

  if (getModel(selectedModel) || getEvalCandidateModel(selectedModel)) {
    return selectedModel;
  }

  return null;
}

export function getValidationSelectedModelBanner(): ValidationSelectedModelBanner | null {
  const selectedModel = getValidationSelectedModelOverride();
  if (!selectedModel || selectedModel === 'auto' || selectedModel === 'eco-fast' || selectedModel === 'eco-smart') {
    return null;
  }

  const catalogModel = getModel(selectedModel);
  const evalCandidate = getEvalCandidateModel(selectedModel);
  const model = catalogModel ?? evalCandidate;
  if (!model) {
    return null;
  }

  const lane = evalCandidate ? 'Eval-only candidate' : 'Catalog model';
  return {
    tone: 'notice',
    title: 'Validation model selected',
    modelId: selectedModel,
    modelLabel: model.friendlyName,
    body: `${lane} ${model.friendlyName} (${selectedModel}) is selected through the local validation harness. This banner is harness-only and does not make it a shipping default.`,
    profileSummary: VALIDATION_PROFILE_INTENTS
      .map((intent) => formatValidationGenerationProfile(intent, selectedModel))
      .join('; '),
  };
}

export function getValidationSlotStatusOverride(
  slot: Slot,
): ValidationSlotStatusOverride | null {
  if (!isValidationHarnessEnabled()) {
    return null;
  }

  return normalizeSlotStatusOverride(
    readHarnessParam(`eco-validation-slot-status-${slot}`),
  );
}

/**
 * Harness-only seam declaring "primed model-slot caches are to be treated as
 * verified; skip boot cache reconciliation." Exists because e2e fixtures prime a
 * slot to 'ready' via localStorage WITHOUT writing real cache bytes; boot
 * reconcile now (correctly) flips such a slot to 'preparing' as a wholly-missing
 * repair, which would defeat the fixtures' pre-seeded-ready convention and their
 * faked generation path. Reads `eco-force-cache-verified` from the URL or
 * localStorage (mirrors the other eco-force-* params). NEVER active on
 * production hosts — gated by `isValidationHarnessEnabled()`.
 */
export function isCacheVerificationForced(): boolean {
  if (!isValidationHarnessEnabled()) {
    return false;
  }

  const value = readHarnessParam('eco-force-cache-verified');
  return value === 'on' || value === 'true' || value === '1';
}

/**
 * Harness-only seam that parks the upgrade swap in its `swapping` phase.
 *
 * The mid-swap tile ("Preparing", with the switch progress bar) exists only
 * while `performUpgradeSwap` runs, and that path re-checks the weights cache
 * first — so a browser that never really downloaded the model reverts to
 * downloading before the tile can be seen or photographed. `eco-force-swap=hold`
 * enters the swapping phase and then holds there, touching no runtime and
 * loading no weights, so the state is reachable without a real multi-gigabyte
 * transfer. NEVER active on production hosts — gated by
 * `isValidationHarnessEnabled()`.
 */
export function getValidationSwapMode(): ValidationSwapMode {
  if (!isValidationHarnessEnabled()) {
    return 'none';
  }

  return readHarnessParam('eco-force-swap') === 'hold' ? 'hold' : 'none';
}

/**
 * Harness-only seam that raises the context-window note.
 *
 * The note ("this model holds less of the conversation") is raised by `useChat`
 * only when a model switch genuinely SHRINKS the window under a conversation
 * that overflows it, which needs two real models bound and a real switch.
 * `eco-force-context-notice=visible` seeds the chatStore state the note reads,
 * so the note can be photographed above a transcript that really does have a
 * context divider. NEVER active on production hosts — gated by
 * `isValidationHarnessEnabled()`.
 */
export function isContextWindowNoticeForced(): boolean {
  if (!isValidationHarnessEnabled()) {
    return false;
  }

  return readHarnessParam('eco-force-context-notice') === 'visible';
}

export function getValidationHarnessBatteryOverride(): {
  level: number;
  charging: boolean;
} | null {
  const { protectionMode } = getValidationHarnessState();

  switch (protectionMode) {
    case 'battery-reduced':
      return { level: 0.15, charging: false };
    case 'battery-disabled':
      return { level: 0.05, charging: false };
    default:
      return null;
  }
}

/** What the failed-reply seam does: fail the reply after its first word. */
export type ValidationGenerationFault = 'mid-reply';

const GENERATION_FAULT_KEY = 'eco-force-generation-fault';

/**
 * The error message a fault from this seam carries, so a browser walk can tell
 * the failure it asked for from a genuine one (the generation receipt records
 * the first 80 characters as its `errorCode`).
 */
export const VALIDATION_GENERATION_FAULT_MESSAGE = 'Validation harness: injected mid-reply fault';

/**
 * Harness-only seam that makes the NEXT chat reply fail after its first word.
 *
 * A browser walk needs a turn that fails on demand to check what a person does
 * next: read the error card, press Try again, and get an answer. Nothing else
 * produces one deterministically — a real mid-reply fault depends on the
 * device. Failing after the first word, rather than before it, also stops
 * reading a live runtime stream part-way, the way a genuine fault does, so the
 * retry proves the runtime is free to answer again.
 *
 * One-shot: `eco-force-generation-fault=mid-reply` is read from localStorage
 * only and removed as it is read, so the retry that follows runs clean. A URL
 * value is ignored on purpose — it would fail every reply on the page. NEVER
 * active on production hosts — gated by `isValidationHarnessEnabled()`.
 */
export function consumeValidationGenerationFault(): ValidationGenerationFault | null {
  if (!isValidationHarnessEnabled()) {
    return null;
  }

  const value = readStorageParam(GENERATION_FAULT_KEY);
  if (value === null) {
    return null;
  }
  safeStorage.remove(GENERATION_FAULT_KEY);
  return value === 'mid-reply' ? 'mid-reply' : null;
}

const GPU_LOSS_KEY = 'eco-force-gpu-loss';

/**
 * Harness-only seam that loses the page's WebGPU device the next time the page
 * is hidden — what a phone does to a page kept alive through a long lock. A
 * browser walk can then return to the page and check that Eco recovers on its
 * own. Read once, at bootstrap, from localStorage `eco-force-gpu-loss`:
 *
 *   - `hide`: destroy every device this page created when it is next hidden.
 *     The runtime's own device-lost handling then runs exactly as on a real
 *     loss (WebLLM disposes its pipeline). One-shot: removed when read.
 *   - `hide-no-adapter`: as `hide`, and `navigator.gpu.requestAdapter()`
 *     resolves null for the rest of this page — a page that can no longer get
 *     a device. One-shot, so the reloaded page is healthy.
 *   - `hide-no-adapter-sticky`: as `hide-no-adapter`, then rewrites itself to
 *     `no-adapter` so every later page in this profile has no adapter either.
 *   - `no-adapter`: `requestAdapter()` resolves null from the start. Kept until
 *     the walk removes it.
 *
 * WebLLM asks for its device on the page's main thread, so wrapping
 * `navigator.gpu` here reaches it. A worker's WebGPU is out of its reach: the
 * ONNX runtime's device lives in its worker, so the transformers adapter reads
 * `isValidationAdapterDenied()` when it starts a worker and, through
 * `subscribeValidationGpuLoss`, asks the worker to destroy its device when this
 * seam destroys the page's. NEVER active on production hosts — gated by
 * `isValidationHarnessEnabled()`.
 *
 * Also installs `window.__ecoHarnessVisibility` (see `installVisibilityControl`),
 * which a walk uses to put the page in the background.
 */
export function installValidationGpuLoss(): void {
  if (!isValidationHarnessEnabled() || typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }
  installVisibilityControl();
  const value = readStorageParam(GPU_LOSS_KEY);
  if (
    value !== 'hide'
    && value !== 'hide-no-adapter'
    && value !== 'hide-no-adapter-sticky'
    && value !== 'no-adapter'
  ) {
    return;
  }
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return;
  if (value === 'hide' || value === 'hide-no-adapter') safeStorage.remove(GPU_LOSS_KEY);

  validationAdapterDenied = value === 'no-adapter';
  const devices: GPUDevice[] = [];
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (options?: GPURequestAdapterOptions): Promise<GPUAdapter | null> => {
    if (validationAdapterDenied) return null;
    const adapter = await requestAdapter(options);
    if (adapter) {
      const requestDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async (descriptor?: GPUDeviceDescriptor): Promise<GPUDevice> => {
        const device = await requestDevice(descriptor);
        devices.push(device);
        return device;
      };
    }
    return adapter;
  };
  if (value === 'no-adapter') return;

  const onHidden = (): void => {
    if (document.visibilityState !== 'hidden') return;
    document.removeEventListener('visibilitychange', onHidden);
    if (value !== 'hide') validationAdapterDenied = true;
    if (value === 'hide-no-adapter-sticky') safeStorage.set(GPU_LOSS_KEY, 'no-adapter');
    for (const device of devices) device.destroy();
    for (const listener of validationGpuLossListeners) listener();
  };
  document.addEventListener('visibilitychange', onHidden);
}

let validationAdapterDenied = false;
const validationGpuLossListeners = new Set<() => void>();

/**
 * Harness-only: whether `eco-force-gpu-loss` has taken this page's WebGPU
 * adapter away. Always false off the harness (the seam never installs).
 */
export function isValidationAdapterDenied(): boolean {
  return validationAdapterDenied;
}

/**
 * Harness-only: `listener` runs when `eco-force-gpu-loss` destroys this page's
 * devices, so a runtime whose device lives in a worker can lose it too. Never
 * called off the harness. Returns an unsubscribe function.
 */
export function subscribeValidationGpuLoss(listener: () => void): () => void {
  validationGpuLossListeners.add(listener);
  return () => {
    validationGpuLossListeners.delete(listener);
  };
}

declare global {
  var __ecoHarnessVisibility: ((state: 'hidden' | 'visible') => void) | undefined;
}

/**
 * Harness-only: report the page as hidden or visible, the way a phone lock
 * does — `document.visibilityState`/`document.hidden` change and
 * `visibilitychange` fires; `pagehide`/`pageshow` do not, since a lock that
 * keeps the page alive fires neither. A browser walk needs this because real
 * tab hiding is suppressed under Playwright: in headed Chrome a tab behind
 * another, a minimized window, and focus emulation all left the page
 * `visible` with no event (measured). The iPhone remains the only proof of the
 * real event order. 'visible' drops the override, so the browser's own value
 * shows again.
 */
function installVisibilityControl(): void {
  if (window.__ecoHarnessVisibility) return;
  window.__ecoHarnessVisibility = (state) => {
    if (state === 'hidden') {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    } else {
      Reflect.deleteProperty(document, 'visibilityState');
      Reflect.deleteProperty(document, 'hidden');
    }
    document.dispatchEvent(new Event('visibilitychange'));
  };
}

export function shouldForceValidationRuntimeCrash(): boolean {
  return getValidationHarnessState().runtimeMode === 'crash';
}

/**
 * The forced download-failure mode a browser validator selected via
 * `eco-force-download`, or `'none'` when unset or the harness is disabled.
 * The download path consumes this to inject a real typed failure at the top of
 * its fetch phase, so download-failure states become drivable in a real browser
 * without a genuinely broken device or host. Gated through
 * `getValidationHarnessState`, so it is always `'none'` in production.
 */
export function getValidationDownloadFailure(): ValidationDownloadFailureMode {
  return getValidationHarnessState().downloadFailure;
}

export const VALIDATION_REMOTE_FIXTURE_MESSAGE_PREFIX = '[[eco-validation-remote-stream:';

const VALIDATION_LOCAL_CONTINUATION_BY_REMOTE_MODE: Record<
  Exclude<ValidationRemoteMode, 'none'>,
  string[]
> = {
  queue: [
    ' The reply stayed in the same turn as a hybrid/offline continuation finished locally after the validation queue drop.',
  ],
  'first-token': [
    ' The same reply became a hybrid/offline continuation finished locally after the forced first-token interruption.',
  ],
};

export function buildValidationRemoteFixtureMessage(): {
  role: 'system';
  content: string;
} | null {
  const { remoteMode } = getValidationHarnessState();

  if (remoteMode === 'none') {
    return null;
  }

  return {
    role: 'system',
    content: `${VALIDATION_REMOTE_FIXTURE_MESSAGE_PREFIX}${remoteMode}]]`,
  };
}

export function getValidationLocalContinuationChunks(
  remoteMode: ValidationRemoteMode,
): string[] {
  if (!isValidationHarnessEnabled() || remoteMode === 'none') {
    return [];
  }

  return VALIDATION_LOCAL_CONTINUATION_BY_REMOTE_MODE[remoteMode];
}

export function getValidationProtectionBanner(
  mode: ValidationProtectionMode,
): ValidationProtectionBanner | null {
  switch (mode) {
    case 'battery-disabled':
      return {
        tone: 'warning',
        title: 'Battery protection pause',
        body: 'Eco paused on-device AI to protect this device. Plug in, then try again to keep chatting locally.',
      };
    case 'thermal':
      return {
        tone: 'notice',
        title: 'Keeping this device cool',
        body: 'Eco is using a steadier local mode for a moment because this device is running warm.',
      };
    case 'memory-pressure':
      return {
        tone: 'notice',
        title: 'Using a lighter local mode',
        body: 'Eco trimmed local work for a moment because this browser is under memory pressure.',
      };
    default:
      return null;
  }
}
