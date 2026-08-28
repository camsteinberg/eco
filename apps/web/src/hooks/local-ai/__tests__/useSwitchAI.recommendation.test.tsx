// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * useSwitchAI — the "Recommended for your device" entry follows
 * deriveFirstRunChoices, so the dialog, the composer, and the welcome card
 * all agree about which model carries the badge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ModelConfig, DeviceProfile, Slot } from '../../../local-ai/types';

const FAST: ModelConfig = {
  id: 'candidate/lfm2.5-1.2b-instruct-onnx',
  friendlyName: 'LFM2.5 1.2B',
  vendor: 'Liquid AI',
  sizeGB: 0.76,
  runtime: 'transformers',
  format: 'onnx-q4f16',
  capabilities: { intent: ['balanced'], tasks: ['chat'], contextTokens: 8192 },
  bestFor: 'conversation',
  knownLimitation: 'k',
  evidenceTier: 'proven',
};

const DEEPER: ModelConfig = {
  id: 'candidate/lfm2-2.6b-onnx',
  friendlyName: 'LFM2 2.6B',
  vendor: 'Liquid AI',
  sizeGB: 1.65,
  runtime: 'transformers',
  format: 'onnx-q4f16',
  capabilities: { intent: ['balanced'], tasks: ['chat'], contextTokens: 8192 },
  bestFor: 'deeper conversation',
  knownLimitation: 'k',
  evidenceTier: 'proven',
};

const CAPABLE_PROFILE = {
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceMemoryGB: 16,
  isMobile: false,
  override: 'auto',
} as DeviceProfile;

const CONSTRAINED_PROFILE = {
  browserClass: 'chromium',
  webgpuSupport: 'wasm-only',
  deviceMemoryGB: 4,
  isMobile: true,
  override: 'auto',
} as DeviceProfile;

// ─── Mocks ──────────────────────────────────────────────────────────────────

let mockProfile: DeviceProfile = CAPABLE_PROFILE;
vi.mock('../useDeviceProfile', () => ({
  useDeviceProfile: () => mockProfile,
}));

vi.mock('../../../local-ai/index', () => ({
  canServe: () => true,
  listCatalog: () => ({
    available: [
      { model: FAST, confidence: 'benchmark' as const },
      { model: DEEPER, confidence: 'calculated' as const },
    ],
  }),
}));

vi.mock('../../../local-ai/display', () => ({
  dedupeByDisplayName: (models: ModelConfig[]) => models,
}));

const { deriveFirstRunChoicesMock } = vi.hoisted(() => ({
  deriveFirstRunChoicesMock: vi.fn(),
}));
vi.mock('../../../local-ai/selection/first-run-choices', () => ({
  deriveFirstRunChoices: deriveFirstRunChoicesMock,
}));

import { useSwitchAI } from '../useSwitchAI';

// ─── Helpers ────────────────────────────────────────────────────────────────

function capableOffer() {
  deriveFirstRunChoicesMock.mockReturnValue({
    choices: [
      { model: FAST, slot: 'eco-fast' as Slot },
      { model: DEEPER, slot: 'eco-smart' as Slot },
    ],
    recommendedId: DEEPER.id,
  });
}

function constrainedOffer() {
  deriveFirstRunChoicesMock.mockReturnValue({
    choices: [{ model: FAST, slot: 'eco-fast' as Slot }],
    recommendedId: FAST.id,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockProfile = CAPABLE_PROFILE;
});

describe('useSwitchAI — recommendation follows deriveFirstRunChoices', () => {
  it('on a capable device the deeper pick is recommended and marked isTop', () => {
    capableOffer();

    const { result } = renderHook(() =>
      useSwitchAI({
        slot: 'eco-fast',
        currentModel: FAST,
        onSwitchRequested: vi.fn(async () => ({ success: true as const })),
      }),
    );

    // The recommendation itself is the deeper model.
    expect(result.current.recommendation?.id).toBe(DEEPER.id);
    // isTop follows the recommendation, so the deeper entry is the one the
    // dialog marks "Recommended for your device".
    const topChoices = result.current.choices.filter((c) => c.isTop);
    expect(topChoices).toHaveLength(1);
    expect(topChoices[0]?.model.id).toBe(DEEPER.id);
  });

  it('on a constrained device the only model is recommended', () => {
    mockProfile = CONSTRAINED_PROFILE;
    constrainedOffer();

    const { result } = renderHook(() =>
      useSwitchAI({
        slot: 'eco-fast',
        currentModel: FAST,
        onSwitchRequested: vi.fn(async () => ({ success: true as const })),
      }),
    );

    expect(result.current.recommendation?.id).toBe(FAST.id);
  });
});
