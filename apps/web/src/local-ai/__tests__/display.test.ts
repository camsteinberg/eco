// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { getDisplayInfo } from '../display';
import { getCatalog } from '../catalog/catalog';

describe('getDisplayInfo', () => {
  it('returns branded names for all 6 catalog models', () => {
    const catalog = getCatalog();
    expect(catalog.length).toBe(6);

    for (const model of catalog) {
      const info = getDisplayInfo(model.id, model);
      // Every catalog model should have a non-empty friendly name
      expect(info.friendlyName).toBeTruthy();
      // Provenance always includes the size
      expect(info.provenance).toContain('GB');
    }
  });

  it('maps Phi-3 Mini to Eco Reasoning (Microsoft)', () => {
    const info = getDisplayInfo('local/phi3-mini-4k-q4f16', {
      friendlyName: 'Phi-3 Mini',
      vendor: 'Microsoft',
      sizeGB: 2.14,
    });
    expect(info.friendlyName).toBe('Eco Reasoning (Microsoft)');
    expect(info.qualityPhrase).toBe('Strongest at math and code');
    expect(info.provenance).toBe('Microsoft · 2.1 GB');
  });


  it('maps Qwen3 to Eco Compact (Qwen)', () => {
    const info = getDisplayInfo('local/qwen3-0.6b', {
      friendlyName: 'Qwen3',
      vendor: 'Alibaba',
      sizeGB: 0.57,
    });
    expect(info.friendlyName).toBe('Eco Compact (Qwen)');
    expect(info.qualityPhrase).toBe('Small + capable · good for limited devices');
    expect(info.provenance).toBe('Alibaba · 0.6 GB');
  });

  it('maps LFM2.5 1.2B to Eco Fast (Liquid) — demoted to the fast/light tier by the everyday-swap', () => {
    const info = getDisplayInfo('candidate/lfm2.5-1.2b-instruct-onnx', {
      friendlyName: 'LFM2.5 1.2B',
      vendor: 'Liquid AI',
      sizeGB: 0.76,
    });
    expect(info.friendlyName).toBe('Eco Fast (Liquid)');
    expect(info.qualityPhrase).toBe('Quickest replies · light footprint');
    expect(info.provenance).toBe('Liquid AI · 0.8 GB');
  });

  it('maps LFM2.5 to Eco Light (Liquid)', () => {
    const info = getDisplayInfo('candidate/lfm2.5-350m-onnx', {
      friendlyName: 'LFM2.5',
      vendor: 'Liquid AI',
      sizeGB: 0.26,
    });
    expect(info.friendlyName).toBe('Eco Light (Liquid)');
    expect(info.qualityPhrase).toBe('Smallest footprint · best for older devices');
    expect(info.provenance).toBe('Liquid AI · 0.3 GB');
  });

  it('maps Qwen3.5 2B to Eco (Qwen) — the everyday default after the swap', () => {
    const info = getDisplayInfo('candidate/qwen3.5-2b-onnx', {
      friendlyName: 'Qwen3.5 2B',
      vendor: 'Alibaba',
      sizeGB: 1.4,
    });
    expect(info.friendlyName).toBe('Eco (Qwen)');
    expect(info.qualityPhrase).toBe('The everyday default · deeper, instruction-faithful answers');
    expect(info.provenance).toBe('Alibaba · 1.4 GB');
  });

  it('falls back to raw friendlyName for unknown model ids', () => {
    const info = getDisplayInfo('local/unknown-model', {
      friendlyName: 'Unknown Model',
      vendor: 'Test Vendor',
      sizeGB: 1.5,
    });
    expect(info.friendlyName).toBe('Unknown Model');
    expect(info.qualityPhrase).toBe('');
    expect(info.provenance).toBe('Test Vendor · 1.5 GB');
  });
});
