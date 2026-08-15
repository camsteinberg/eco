// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { getDisplayInfo, resolveRunningModel } from '../display';
import { getCatalog } from '../catalog/catalog';

describe('getDisplayInfo', () => {
  it('returns branded names for all 11 catalog models', () => {
    const catalog = getCatalog();
    expect(catalog.length).toBe(11);

    for (const model of catalog) {
      const info = getDisplayInfo(model.id, model);
      // Every catalog model must have a BRANDED entry, not the raw-name fallback:
      // a missing DISPLAY_MAP entry leaks the raw model name ("Qwen2.5 0.5B") and
      // an empty qualityPhrase into primary UI, violating display.ts:9 / MC-4.
      expect(info.friendlyName, model.id).toMatch(/^Eco /);
      expect(info.qualityPhrase, model.id).toBeTruthy();
      // Provenance always includes the size
      expect(info.provenance).toContain('GB');
    }
  });

  it('maps Qwen2.5 0.5B (int8 CPU floor) to a branded name — not the raw model name (MC-4)', () => {
    const info = getDisplayInfo('candidate/qwen2.5-0.5b-instruct-onnx', {
      friendlyName: 'Qwen2.5 0.5B',
      vendor: 'Alibaba',
      sizeGB: 0.52,
    });
    expect(info.friendlyName).toBe('Eco Basic (Qwen)');
    expect(info.qualityPhrase).toBeTruthy();
    expect(info.provenance).toBe('Alibaba · 0.5 GB');
  });

  it('maps SmolLM2 360M (lightest int8 CPU floor) to a branded name — not the raw model name (MC-4)', () => {
    const info = getDisplayInfo('candidate/smollm2-360m-instruct-onnx', {
      friendlyName: 'SmolLM2 360M',
      vendor: 'Hugging Face',
      sizeGB: 0.37,
    });
    expect(info.friendlyName).toBe('Eco Tiny (SmolLM)');
    expect(info.qualityPhrase).toBeTruthy();
    expect(info.provenance).toBe('Hugging Face · 0.4 GB');
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

  it('maps LFM2.5 1.2B to Eco Fast (Liquid) — the everyday default (model-ladder read 2026-08-09)', () => {
    const info = getDisplayInfo('candidate/lfm2.5-1.2b-instruct-onnx', {
      friendlyName: 'LFM2.5 1.2B',
      vendor: 'Liquid AI',
      sizeGB: 0.76,
    });
    expect(info.friendlyName).toBe('Eco Fast (Liquid)');
    expect(info.qualityPhrase).toBe('The everyday default · quick, clear answers');
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

  it('maps Qwen3.5 2B to Eco (Qwen) — an opt-in larger model (no longer the everyday default)', () => {
    const info = getDisplayInfo('candidate/qwen3.5-2b-onnx', {
      friendlyName: 'Qwen3.5 2B',
      vendor: 'Alibaba',
      sizeGB: 1.4,
    });
    expect(info.friendlyName).toBe('Eco (Qwen)');
    expect(info.qualityPhrase).toBe('A larger model · longer, slower answers');
    expect(info.provenance).toBe('Alibaba · 1.4 GB');
  });

  it('maps LFM2 2.6B to Eco Deeper (Liquid) — the graduated deeper pick (2026-08-10)', () => {
    const info = getDisplayInfo('candidate/lfm2-2.6b-onnx', {
      friendlyName: 'LFM2 2.6B',
      vendor: 'Liquid AI',
      sizeGB: 1.65,
    });
    expect(info.friendlyName).toBe('Eco Deeper (Liquid)');
    expect(info.qualityPhrase).toBe('A deeper model · stronger reasoning and code');
    expect(info.provenance).toBe('Liquid AI · 1.6 GB');
  });

  it('maps Qwen2.5 0.5B to Eco Mobile (Qwen) — the WebKit-mobile pick', () => {
    const info = getDisplayInfo('candidate/qwen2.5-0.5b-mlc', {
      friendlyName: 'Qwen2.5 0.5B',
      vendor: 'Alibaba',
      sizeGB: 0.27,
    });
    expect(info.friendlyName).toBe('Eco Mobile (Qwen)');
    expect(info.qualityPhrase).toBe('Made for iPhone · quick private chat on the go');
    expect(info.provenance).toBe('Alibaba · 0.3 GB');
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

// "Currently running" must name the model the chat's current selection
// actually resolves to — not blindly prefer eco-fast. A stale eco-fast
// binding out-named the genuinely serving eco-smart model live on
// 2026-08-05 ("Eco Mobile (Qwen)" on a desktop running the 2B).
describe('resolveRunningModel', () => {
  const [modelA, modelB] = getCatalog();
  if (!modelA || !modelB) throw new Error('catalog too small');

  const slots = (
    fast: { model: typeof modelA | null; status: string },
    smart: { model: typeof modelA | null; status: string },
  ) => ({ 'eco-fast': fast, 'eco-smart': smart }) as Parameters<typeof resolveRunningModel>[1];

  it('follows the selected slot even when eco-fast holds a different model', () => {
    const view = slots(
      { model: modelB, status: 'ready' },
      { model: modelA, status: 'ready' },
    );
    const running = resolveRunningModel('eco-smart', view);
    expect(running.model?.id).toBe(modelA.id);
    expect(running.status).toBe('ready');
  });

  it('resolves a concrete model id to the slot that owns it', () => {
    const view = slots(
      { model: modelB, status: 'ready' },
      { model: modelA, status: 'preparing' },
    );
    const running = resolveRunningModel(modelA.id, view);
    expect(running.model?.id).toBe(modelA.id);
    expect(running.status).toBe('preparing');
  });

  it('falls back fast-then-smart when the selection resolves to an empty slot', () => {
    const view = slots(
      { model: null, status: 'empty' },
      { model: modelA, status: 'ready' },
    );
    const running = resolveRunningModel('eco-fast', view);
    expect(running.model?.id).toBe(modelA.id);
    expect(running.status).toBe('ready');
  });

  it('returns null when no slot holds a model', () => {
    const view = slots({ model: null, status: 'empty' }, { model: null, status: 'empty' });
    const running = resolveRunningModel('eco-fast', view);
    expect(running.model).toBeNull();
    expect(running.status).toBeNull();
  });
});
