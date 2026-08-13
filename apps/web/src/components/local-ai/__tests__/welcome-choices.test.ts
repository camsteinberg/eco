// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest';
import { toWelcomeChoice, toWelcomeChoices } from '../welcome-choices';
import type { ModelConfig } from '../../../local-ai/types';

const base = (over: Partial<ModelConfig>): ModelConfig => ({
  id: 'x',
  friendlyName: 'X',
  vendor: 'V',
  sizeGB: 1,
  runtime: 'transformers',
  format: 'onnx-q4f16',
  capabilities: { intent: ['balanced'], tasks: ['chat'], contextTokens: 4096 },
  bestFor: '',
  knownLimitation: '',
  evidenceTier: 'proven',
  ...over,
});

describe('toWelcomeChoice', () => {
  it('maps Eco Fast (1.2B) to curated copy and an honest size', () => {
    const c = toWelcomeChoice(base({ id: 'candidate/lfm2.5-1.2b-instruct-onnx', sizeGB: 0.76 }));
    expect(c).toMatchObject({
      id: 'candidate/lfm2.5-1.2b-instruct-onnx',
      name: 'Eco Fast',
      sizeLabel: '~0.8 GB',
      speed: 4,
      depth: 2,
    });
    expect(c.tagline).toBeTruthy();
  });

  it('maps Eco Deeper (2.6B) to curated copy and an honest size', () => {
    const c = toWelcomeChoice(base({ id: 'candidate/lfm2-2.6b-onnx', sizeGB: 1.65 }));
    expect(c).toMatchObject({ name: 'Eco Deeper', sizeLabel: '~1.7 GB', speed: 2, depth: 4 });
  });

  it('falls back for an unmapped model, dropping the vendor suffix and scaling meters by size', () => {
    const c = toWelcomeChoice(
      base({ id: 'candidate/unknown-x', friendlyName: 'Eco Whatever (Acme)', sizeGB: 2.1 }),
    );
    expect(c.name).toBe('Eco Whatever');
    expect(c.sizeLabel).toBe('~2.1 GB');
    expect(c.speed).toBe(2); // > 1.4 GB → slow + deep
    expect(c.depth).toBe(4);
    expect(c.tagline).toBeTruthy();
  });
});

describe('toWelcomeChoices', () => {
  it('maps a list best-first, preserving order', () => {
    const list = toWelcomeChoices([
      base({ id: 'candidate/lfm2.5-1.2b-instruct-onnx', sizeGB: 0.76 }),
      base({ id: 'candidate/lfm2-2.6b-onnx', sizeGB: 1.65 }),
    ]);
    expect(list.map((c) => c.name)).toEqual(['Eco Fast', 'Eco Deeper']);
  });
});
