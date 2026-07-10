// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildValidationRemoteFixtureMessage,
  getValidationConversationHistoryFixture,
  getValidationDownloadFailure,
  getValidationHeavyWorkDryRun,
  getValidationLocalGenerationFixture,
  getValidationLocalContinuationChunks,
  getValidationHarnessState,
  getValidationLocalDeviceProfileOverride,
  getValidationSelectedModelBanner,
  getValidationSelectedModelOverride,
  getValidationSlotModelOverride,
  getValidationSlotStatusOverride,
  isCacheVerificationForced,
  isValidationHarnessEnabledForEnvironment,
  VALIDATION_REMOTE_FIXTURE_MESSAGE_PREFIX,
} from '../validation-harness';
import { isValidationHarnessRequestAllowed } from '../validation-harness-server';
import {
  cancelValidationLocalHeavyWorkDryRun,
  getActiveLocalHeavyWorkLease,
  startValidationLocalHeavyWorkDryRun,
} from '../local-heavy-work-owner';

describe('validation remote stream harness', () => {
  const originalPathAndQuery = `${window.location.pathname}${window.location.search}`;

  beforeEach(() => {
    window.history.replaceState({}, '', '/chat');
  });

  afterEach(() => {
    window.history.replaceState({}, '', originalPathAndQuery);
    window.localStorage.clear();
    vi.unstubAllEnvs();
  });

  it('defaults remote validation controls to none', () => {
    expect(getValidationHarnessState().remoteMode).toBe('none');
    expect(buildValidationRemoteFixtureMessage()).toBeNull();
  });

  it('exposes the queue fixture control through the mission harness URL', () => {
    window.history.replaceState({}, '', '/chat?eco-force-remote=queue');

    expect(getValidationHarnessState().remoteMode).toBe('queue');
    expect(buildValidationRemoteFixtureMessage()).toEqual({
      role: 'system',
      content: `${VALIDATION_REMOTE_FIXTURE_MESSAGE_PREFIX}queue]]`,
    });
  });

  it('exposes the first-token fixture control through the mission harness URL', () => {
    window.history.replaceState({}, '', '/chat?eco-force-remote=first-token');

    expect(getValidationHarnessState().remoteMode).toBe('first-token');
    expect(buildValidationRemoteFixtureMessage()).toEqual({
      role: 'system',
      content: `${VALIDATION_REMOTE_FIXTURE_MESSAGE_PREFIX}first-token]]`,
    });
  });

  it('provides deterministic local-continuation copy for remote interruption proof routes', () => {
    window.history.replaceState({}, '', '/chat?eco-force-remote=first-token');

    expect(getValidationLocalContinuationChunks(getValidationHarnessState().remoteMode)).toEqual([
      ' The same reply became a hybrid/offline continuation finished locally after the forced first-token interruption.',
    ]);
  });

  it('exposes deterministic conversation-history fixture controls only through the mission harness URL', () => {
    window.history.replaceState({}, '', '/chat?eco-history-fixture=assistant-dom');
    expect(getValidationConversationHistoryFixture()).toBe('assistant-dom');

    window.history.replaceState({}, '', '/chat?eco-history-fixture=hybrid-continuation');
    expect(getValidationConversationHistoryFixture()).toBe('hybrid-continuation');

    window.history.replaceState({}, '', '/chat?eco-history-fixture=clear');
    expect(getValidationConversationHistoryFixture()).toBe('clear');

    window.history.replaceState({}, '', '/chat?eco-history-fixture=<script>');
    expect(getValidationConversationHistoryFixture()).toBe('none');
  });

  it('exposes a scoped smoke-ready local generation fixture for one concrete model', () => {
    window.history.replaceState(
      {},
      '',
      '/chat?eco-local-generation-fixture=smoke-ready&eco-local-generation-model=local/qwen3-0.6b&eco-local-generation-slot=eco-fast',
    );

    expect(getValidationLocalGenerationFixture('local/qwen3-0.6b')).toMatchObject({
      mode: 'smoke-ready',
      modelId: 'local/qwen3-0.6b',
      slot: 'eco-fast',
    });
    expect(getValidationLocalGenerationFixture('local/qwen3-0.6b')?.chunks.join('')).toContain(
      'local/fixture response',
    );
    expect(getValidationLocalGenerationFixture('local/smollm3-3b')).toBeNull();
  });

  it('exposes validation-only slot overrides for catalog and eval candidate models', () => {
    window.history.replaceState(
      {},
      '',
      '/chat?eco-validation-slot-eco-fast=candidate%2Fgemma-4-e2b-litert&eco-validation-slot-status-eco-fast=ready&eco-validation-slot-eco-smart=local%2Fqwen3-0.6b&eco-validation-slot-status-eco-smart=preparing',
    );

    expect(getValidationSlotModelOverride('eco-fast')).toBe('candidate/gemma-4-e2b-litert');
    expect(getValidationSlotStatusOverride('eco-fast')).toBe('ready');
    expect(getValidationSlotModelOverride('eco-smart')).toBe('local/qwen3-0.6b');
    expect(getValidationSlotStatusOverride('eco-smart')).toBe('preparing');
  });

  it.each([
    // gemma-4-e2b-litert GRADUATED to the shipping catalog (2026-06-29); e4b
    // stays eval-only, so it's the validation-harness fixture now.
    ['candidate/gemma-4-e4b-litert', 'candidate%2Fgemma-4-e4b-litert'],
  ] as const)('exposes a validation-only selected model override for eval candidate %s', (modelId, encodedModelId) => {
    window.history.replaceState(
      {},
      '',
      `/chat?eco-validation-selected-model=${encodedModelId}`,
    );

    expect(getValidationSelectedModelOverride()).toBe(modelId);
  });

  it('exposes a validation-only selected model override for slot aliases', () => {
    window.history.replaceState(
      {},
      '',
      '/chat?eco-validation-selected-model=eco-fast',
    );
    expect(getValidationSelectedModelOverride()).toBe('eco-fast');
  });

  it.each([
    // e2b graduated to the catalog; e4b remains the eval-only banner fixture.
    [
      'candidate/gemma-4-e4b-litert',
      'candidate%2Fgemma-4-e4b-litert',
      'Gemma 4 E4B (LiteRT)',
    ],
  ] as const)('builds a visible validation-selected model banner for %s overrides', (modelId, encodedModelId, modelLabel) => {
    window.history.replaceState(
      {},
      '',
      `/chat?eco-validation-selected-model=${encodedModelId}`,
    );

    expect(getValidationSelectedModelBanner()).toMatchObject({
      title: 'Validation model selected',
      modelId,
      modelLabel,
      tone: 'notice',
    });
    expect(getValidationSelectedModelBanner()?.body).toContain('Eval-only candidate');
    expect(getValidationSelectedModelBanner()?.body).toContain(modelId);
    expect(getValidationSelectedModelBanner()?.profileSummary).toContain('quick');
    expect(getValidationSelectedModelBanner()?.profileSummary).toContain('top_k 64');
    expect(getValidationSelectedModelBanner()?.profileSummary).not.toContain('repetition');
  });

  it('does not build a selected-model banner for slot aliases or unknown overrides', () => {
    window.history.replaceState({}, '', '/chat?eco-validation-selected-model=eco-fast');
    expect(getValidationSelectedModelBanner()).toBeNull();

    window.history.replaceState({}, '', '/chat?eco-validation-selected-model=unknown%2Fmodel');
    expect(getValidationSelectedModelBanner()).toBeNull();
  });

  it('rejects unknown validation selected model overrides', () => {
    window.history.replaceState(
      {},
      '',
      '/chat?eco-validation-selected-model=unknown%2Fmodel',
    );

    expect(getValidationSelectedModelOverride()).toBeNull();
  });

  it('rejects unknown validation slot override models and statuses', () => {
    window.history.replaceState(
      {},
      '',
      '/chat?eco-validation-slot-eco-fast=unknown%2Fmodel&eco-validation-slot-status-eco-fast=<script>',
    );

    expect(getValidationSlotModelOverride('eco-fast')).toBeNull();
    expect(getValidationSlotStatusOverride('eco-fast')).toBeNull();
  });

  it('accepts mission-owned storage override state only while the harness is enabled', () => {
    window.localStorage.setItem('eco-force-download', 'storage');
    window.localStorage.setItem('eco-force-local-runtime', 'crash');
    window.localStorage.setItem('eco-force-protection', 'thermal');
    window.localStorage.setItem('eco-force-remote', 'queue');

    expect(getValidationHarnessState()).toMatchObject({
      enabled: true,
      downloadFailure: 'storage',
      runtimeMode: 'crash',
      protectionMode: 'thermal',
      remoteMode: 'queue',
      heavyWorkDryRun: 'none',
    });
  });

  it('exposes scoped heavy-work dry-run controls only through the mission harness', () => {
    window.history.replaceState(
      {},
      '',
      '/settings?tab=models&eco-heavy-work-dry-run=readiness&eco-heavy-work-model=local/bonsai-1.7b-q1',
    );

    expect(getValidationHarnessState().heavyWorkDryRun).toBe('readiness');
    expect(getValidationHeavyWorkDryRun()).toMatchObject({
      mode: 'readiness',
      modelId: 'local/bonsai-1.7b-q1',
      label: 'local/bonsai-1.7b-q1',
    });

    window.history.replaceState(
      {},
      '',
      '/settings?tab=models&eco-heavy-work-dry-run=<script>',
    );
    expect(getValidationHarnessState().heavyWorkDryRun).toBe('none');
    expect(getValidationHeavyWorkDryRun()).toBeNull();
  });

  it('can start and cancel a representative heavy-work dry-run lease', () => {
    window.history.replaceState(
      {},
      '',
      '/settings?tab=models&eco-heavy-work-dry-run=benchmark&eco-heavy-work-model=local/qwen3-0.6b',
    );

    const lease = startValidationLocalHeavyWorkDryRun(1_000);

    expect(lease).toMatchObject({
      kind: 'benchmark',
      ownerId: 'validation-dry-run:benchmark:local/qwen3-0.6b',
    });
    expect(getActiveLocalHeavyWorkLease(1_001)?.kind).toBe('benchmark');

    cancelValidationLocalHeavyWorkDryRun();

    expect(getActiveLocalHeavyWorkLease(1_002)).toBeNull();
  });

  it('clears validation dry-run leases after leaving the dry-run URL', () => {
    window.history.replaceState(
      {},
      '',
      '/settings?tab=models&eco-heavy-work-dry-run=download&eco-heavy-work-model=local/bonsai-1.7b-q1',
    );

    expect(startValidationLocalHeavyWorkDryRun(1_000)).toMatchObject({
      ownerId: 'validation-dry-run:download:local/bonsai-1.7b-q1',
    });

    window.history.replaceState({}, '', '/settings?tab=models');

    expect(getActiveLocalHeavyWorkLease(1_001)).toBeNull();
  });

  it('replaces a stale validation dry-run lease when the requested dry-run changes', () => {
    window.history.replaceState(
      {},
      '',
      '/settings?tab=models&eco-heavy-work-dry-run=download&eco-heavy-work-model=local/bonsai-1.7b-q1',
    );

    expect(startValidationLocalHeavyWorkDryRun(1_000)).toMatchObject({
      ownerId: 'validation-dry-run:download:local/bonsai-1.7b-q1',
    });

    window.history.replaceState(
      {},
      '',
      '/settings?tab=models&eco-heavy-work-dry-run=readiness&eco-heavy-work-model=local/qwen3-0.6b',
    );

    expect(startValidationLocalHeavyWorkDryRun(1_001)).toMatchObject({
      kind: 'readiness',
      ownerId: 'validation-dry-run:readiness:local/qwen3-0.6b',
    });
  });

  it('exposes scoped storage/cache/OPFS/quota and degraded profile fixture controls', () => {
    window.history.replaceState(
      {},
      '',
      '/settings?tab=models&eco-force-download=opfs&eco-force-capability=wasm&eco-force-browser=firefox&eco-force-platform=desktop&eco-force-device-memory=4&eco-force-opfs=false&eco-force-data-saver=true&eco-force-metered=true&eco-force-connection=2g',
    );

    expect(getValidationHarnessState().downloadFailure).toBe('opfs');
    expect(getValidationDownloadFailure()).toBe('opfs');
    expect(getValidationLocalDeviceProfileOverride()).toEqual({
      capability: 'wasm',
      browserClass: 'firefox',
      platformClass: 'desktop',
      deviceMemoryGB: 4,
      opfsAvailable: false,
      dataSaverEnabled: true,
      meteredConnection: true,
      effectiveConnectionType: '2g',
    });

    for (const mode of ['cache', 'quota', 'storage', 'hosting'] as const) {
      window.history.replaceState({}, '', '/settings?tab=models');
      window.localStorage.setItem('eco-force-download', mode);
      expect(getValidationHarnessState().downloadFailure).toBe(mode);
      expect(getValidationDownloadFailure()).toBe(mode);
    }

    window.history.replaceState({}, '', '/settings?tab=models');
    window.localStorage.setItem('eco-force-download', 'nonsense');
    expect(getValidationDownloadFailure()).toBe('none');
  });

  it('ignores mission-only query seams on production public hosts', () => {
    expect(
      isValidationHarnessEnabledForEnvironment({
        hostname: 'econetwork.ai',
        nodeEnv: 'production',
        explicitHarnessEnabled: true,
      }),
    ).toBe(false);
    expect(
      isValidationHarnessEnabledForEnvironment({
        hostname: 'www.econetwork.ai',
        nodeEnv: 'production',
        explicitHarnessEnabled: false,
      }),
    ).toBe(false);
  });

  it('allows explicit production validation only on loopback hosts', () => {
    expect(
      isValidationHarnessEnabledForEnvironment({
        hostname: 'localhost',
        nodeEnv: 'production',
        explicitHarnessEnabled: true,
      }),
    ).toBe(true);
    expect(
      isValidationHarnessEnabledForEnvironment({
        hostname: '127.0.0.1',
        nodeEnv: 'production',
        explicitHarnessEnabled: false,
      }),
    ).toBe(false);
  });

  it('allows loopback development validation and denies production public hosts', () => {
    const headers = new Headers({ host: 'localhost:3101' });

    expect(isValidationHarnessRequestAllowed(headers)).toBe(true);

    vi.stubEnv('NEXT_PUBLIC_ECO_VALIDATION_HARNESS', 'true');
    vi.stubEnv('NODE_ENV', 'production');

    expect(isValidationHarnessRequestAllowed(new Headers({ host: 'econetwork.ai' }))).toBe(false);
    expect(isValidationHarnessRequestAllowed(headers)).toBe(true);
  });

  it('allows comma-separated loopback host headers without trusting mixed public hosts', () => {
    expect(
      isValidationHarnessRequestAllowed(
        new Headers({ host: '127.0.0.1:3100, localhost:3100' }),
      ),
    ).toBe(true);

    vi.stubEnv('NEXT_PUBLIC_ECO_VALIDATION_HARNESS', 'true');
    vi.stubEnv('NODE_ENV', 'production');

    expect(
      isValidationHarnessRequestAllowed(
        new Headers({ host: '127.0.0.1:3100, econetwork.ai' }),
      ),
    ).toBe(false);
  });

  it('allows explicit development validation when the framework omits host headers', () => {
    vi.stubEnv('NEXT_PUBLIC_ECO_VALIDATION_HARNESS', 'true');
    vi.stubEnv('NODE_ENV', 'development');

    expect(isValidationHarnessRequestAllowed(new Headers())).toBe(true);

    vi.stubEnv('NODE_ENV', 'production');

    expect(isValidationHarnessRequestAllowed(new Headers())).toBe(false);
  });

  it('allows the server-only validation harness opt-in on loopback hosts only', () => {
    vi.stubEnv('ECO_VALIDATION_HARNESS', 'true');
    vi.stubEnv('NODE_ENV', 'production');

    expect(isValidationHarnessRequestAllowed(new Headers({ host: 'localhost:3101' }))).toBe(true);
    expect(isValidationHarnessRequestAllowed(new Headers({ host: 'econetwork.ai' }))).toBe(false);
  });

  it('does not trust spoofed forwarded hosts for server benchmark harness requests', () => {
    vi.stubEnv('NEXT_PUBLIC_ECO_VALIDATION_HARNESS', 'true');
    vi.stubEnv('NODE_ENV', 'production');

    expect(
      isValidationHarnessRequestAllowed(
        new Headers({
          host: 'econetwork.ai',
          'x-forwarded-host': 'localhost:3101',
        }),
      ),
    ).toBe(false);
  });
});

describe('isCacheVerificationForced (e2e fixture cache seam)', () => {
  const originalPathAndQuery = `${window.location.pathname}${window.location.search}`;

  beforeEach(() => {
    window.history.replaceState({}, '', '/chat');
  });

  afterEach(() => {
    window.history.replaceState({}, '', originalPathAndQuery);
    window.localStorage.clear();
    vi.unstubAllEnvs();
  });

  it('defaults to false when the param is absent', () => {
    expect(isCacheVerificationForced()).toBe(false);
  });

  it('reads the on/true/1 forms from the URL', () => {
    for (const value of ['on', 'true', '1']) {
      window.history.replaceState({}, '', `/chat?eco-force-cache-verified=${value}`);
      expect(isCacheVerificationForced()).toBe(true);
    }
  });

  it('reads the param from localStorage (fallback used by the visual fixtures)', () => {
    window.localStorage.setItem('eco-force-cache-verified', '1');
    expect(isCacheVerificationForced()).toBe(true);
  });

  it('treats other values as false', () => {
    window.history.replaceState({}, '', '/chat?eco-force-cache-verified=nope');
    expect(isCacheVerificationForced()).toBe(false);
  });

  it('is false in production even when the param is set (never leaks to prod)', () => {
    vi.stubEnv('NEXT_PUBLIC_ECO_VALIDATION_HARNESS', 'false');
    vi.stubEnv('NODE_ENV', 'production');
    window.history.replaceState({}, '', '/chat?eco-force-cache-verified=1');
    // The harness gate is closed in production (isValidationHarnessEnabled
    // returns false), so the seam is inert regardless of the param.
    expect(isCacheVerificationForced()).toBe(false);
  });
});
