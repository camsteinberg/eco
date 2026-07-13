// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest';
import { getLocalModelSystemPromptSuffix } from '../system-prompt';

// ---------------------------------------------------------------------------
// Per-model formatting suffix
// ---------------------------------------------------------------------------

describe('getLocalModelSystemPromptSuffix', () => {
  // -- Models WITH catalog systemDirective return it --

  it('returns systemDirective for Phi-3 Mini', () => {
    const suffix = getLocalModelSystemPromptSuffix('local/phi3-mini-4k-q4f16');
    expect(suffix).not.toBeNull();
    expect(suffix).toContain('Answer directly');
  });

  // -- Models WITHOUT catalog systemDirective return null --

  it('returns null for Bonsai (no systemDirective in catalog)', () => {
    expect(getLocalModelSystemPromptSuffix('local/bonsai-1.7b-q4')).toBeNull();
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
      'local/phi3-mini-4k-q4f16',
      'local/bonsai-1.7b-q4',
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
    expect(getLocalModelSystemPromptSuffix('local/rwkv7-1.5b')).toBeNull();
    expect(getLocalModelSystemPromptSuffix('local/smollm3-3b')).toBeNull();
  });
});
