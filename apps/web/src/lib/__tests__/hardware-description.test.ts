// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest';

// Mock local-models before importing
vi.mock('../local-models', () => ({
  getRecommendedModel: () => ({
    id: 'local/qwen3-0.6b',
    displayName: 'Qwen3 0.6B',
    estimatedSize: '~543MB',
    tier: 'quick' as const,
  }),
  getQuickModel: () => ({
    id: 'local/qwen3-0.6b',
    displayName: 'Qwen3 0.6B',
    estimatedSize: '~543MB',
    tier: 'quick' as const,
  }),
  getFullModel: () => ({
    id: 'local/smollm3-3b',
    displayName: 'SmolLM3 3B',
    estimatedSize: '~2GB',
    tier: 'full' as const,
  }),
  getLaunchLocalModels: () => [
    {
      id: 'local/qwen3-0.6b',
      displayName: 'Qwen3 0.6B',
      estimatedSize: '~543MB',
      tier: 'quick' as const,
    },
    {
      id: 'local/smollm3-3b',
      displayName: 'SmolLM3 3B',
      estimatedSize: '~2GB',
      tier: 'full' as const,
    },
  ],
  getRoutableLocalModels: () => [
    {
      id: 'local/qwen3-0.6b',
      displayName: 'Qwen3 0.6B',
      estimatedSize: '~543MB',
      tier: 'quick' as const,
    },
    {
      id: 'local/smollm3-3b',
      displayName: 'SmolLM3 3B',
      estimatedSize: '~2GB',
      tier: 'full' as const,
    },
  ],
  getLocalModel: (id: string) => {
    const models = [
      {
        id: 'local/qwen3-0.6b',
        displayName: 'Qwen3 0.6B',
        estimatedSize: '~543MB',
        tier: 'quick' as const,
      },
      {
        id: 'local/smollm3-3b',
        displayName: 'SmolLM3 3B',
        estimatedSize: '~2GB',
        tier: 'full' as const,
      },
    ];
    return models.find((model) => model.id === id);
  },
  getLocalModelTechnicalName: (model: { displayName: string }) => model.displayName,
  getLocalModelUserFacingSurfaceBlockers: () => [],
}));

// Mock the v1 slots module that hardware-description now imports
vi.mock('../../local-ai/lifecycle/slots', () => ({
  getSlot: (slot: string) => ({
    slot,
    modelId: null,
    model: null,
    status: 'empty' as const,
  }),
  getSlotDisplayInfos: () => [
    { slot: 'eco-fast', modelId: null, model: null, status: 'empty' as const, displayName: 'Instant start', description: 'Answers the moment you arrive' },
    { slot: 'eco-smart', modelId: null, model: null, status: 'empty' as const, displayName: 'Main model', description: 'The strongest Eco for this device' },
  ],
}));

import {
  describeCapability,
  describeMemory,
  recommendModel,
  recommendModelSlots,
} from '../hardware-description';

describe('describeCapability', () => {
  it('returns powerful GPU message for webgpu with 8+ GB', () => {
    expect(describeCapability('webgpu', 8)).toBe(
      'Your GPU can run powerful models locally',
    );
  });

  it('returns standard GPU message for webgpu with <8 GB', () => {
    expect(describeCapability('webgpu', 4)).toBe(
      'Your GPU can run models locally',
    );
  });

  it('returns smaller models message for wasm', () => {
    expect(describeCapability('wasm', null)).toBe(
      'Your device can run smaller models locally',
    );
  });

  it('returns unsupported message for unsupported capability', () => {
    expect(describeCapability('unsupported', null)).toBe(
      "Your browser doesn't support local AI yet",
    );
  });
});

describe('describeMemory', () => {
  it('returns empty string for null memory', () => {
    expect(describeMemory(null)).toBe('');
  });

  it('returns plenty message for 16+ GB', () => {
    expect(describeMemory(16)).toBe('Plenty of memory for large models');
  });

  it('returns good message for 8+ GB', () => {
    expect(describeMemory(8)).toBe('Good memory for standard models');
  });

  it('returns limited message for <8 GB', () => {
    expect(describeMemory(4)).toBe('Limited memory — smaller models recommended');
  });
});

describe('recommendModel', () => {
  it('does not recommend a concrete local model while default eligibility is held', () => {
    expect(recommendModel('webgpu', 8)).toBeNull();
  });

  it('does not fall back to a quick model on wasm without default eligibility', () => {
    expect(recommendModel('wasm', null)).toBeNull();
  });

  it('returns null for unsupported', () => {
    expect(recommendModel('unsupported', null)).toBeNull();
  });
});

describe('recommendModelSlots', () => {
  it('returns both held Eco role slots until default eligibility clears', () => {
    const slots = recommendModelSlots('webgpu', 16);
    expect(slots.map((slot) => slot.slot)).toEqual(['eco-fast', 'eco-smart']);
    expect(slots[0]!.model).toBeNull();
    expect(slots[1]!.model).toBeNull();
  });
});
