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
import { getModel } from '../local-ai/catalog/catalog';
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
    readHarnessParam('eco-local-generation-model') ?? 'local/bonsai-1.7b-q1';
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
