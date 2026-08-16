// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest';
import { getLocalModelSystemPromptSuffix } from '../system-prompt';
import * as catalog from '../../catalog/catalog';

// ---------------------------------------------------------------------------
// Per-model formatting suffix
// ---------------------------------------------------------------------------

describe('getLocalModelSystemPromptSuffix', () => {
  // -- Models WITH catalog systemDirective return it --

  // Phi-3 (retired 2026-08-15, MC-2) was the only catalog model with a
  // systemDirective; the passthrough still ships, so keep it under test with a
  // synthetic directive-bearing model rather than a live catalog id.
  it('returns the catalog systemDirective when a model has one', () => {
    const spy = vi
      .spyOn(catalog, 'getModel')
      .mockReturnValue({ systemDirective: 'Answer directly.' } as unknown as ReturnType<typeof catalog.getModel>);
    try {
      const suffix = getLocalModelSystemPromptSuffix('synthetic/directive-model');
      expect(suffix).not.toBeNull();
      expect(suffix).toContain('Answer directly');
    } finally {
      spy.mockRestore();
    }
  });

  // -- Models WITHOUT catalog systemDirective return null --

  it('returns null for Bonsai (no systemDirective in catalog)', () => {
    expect(getLocalModelSystemPromptSuffix('local/qwen3-0.6b')).toBeNull();
  });

  it('returns null for Qwen3 0.6B (no systemDirective in catalog)', () => {
    expect(getLocalModelSystemPromptSuffix('local/qwen3-0.6b')).toBeNull();
  });

  it('returns null for LFM2.5 350M (no systemDirective in catalog)', () => {
    expect(getLocalModelSystemPromptSuffix('candidate/lfm2.5-350m-onnx')).toBeNull();
  });

  // -- Regression guard: FORMAT_NUDGE is fully removed --

  it('does NOT contain "numbered lists" for any catalog model (FORMAT_NUDGE removed)', () => {
    const ids = [
      'candidate/lfm2.5-1.2b-instruct-onnx',
      'local/qwen3-0.6b',
      'local/qwen3-0.6b',
      'candidate/lfm2.5-350m-onnx',
    ];
    for (const id of ids) {
      const suffix = getLocalModelSystemPromptSuffix(id);
      if (suffix !== null) {
        expect(suffix).not.toContain('numbered lists');
        expect(suffix).not.toContain('```');
      }
    }
  });

  // -- Non-catalog models --

  it('returns null for non-catalog model ids', () => {
    expect(getLocalModelSystemPromptSuffix('local/smollm3-3b')).toBeNull();
  });
});
