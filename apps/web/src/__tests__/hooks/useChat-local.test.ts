// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest';
import { isLocalAiModel } from '../../local-ai/util';

describe('isLocalAiModel branch detection', () => {
  it('isLocalAiModel returns true for local/smollm3-3b', () => {
    expect(isLocalAiModel('local/smollm3-3b')).toBe(true);
  });

  it('isLocalAiModel returns false for auto', () => {
    expect(isLocalAiModel('auto')).toBe(false);
  });

  it('isLocalAiModel returns false for non-local model IDs', () => {
    expect(isLocalAiModel('some-other-model')).toBe(false);
  });

  it('isLocalAiModel returns true for any local/ prefixed ID', () => {
    expect(isLocalAiModel('local/qwen3-0.6b')).toBe(true);
  });
});

// Integration testing for ChatMessage.inferenceMethod is covered by:
// - chat-inference-method.test.ts (store-level)
// - Playwright E2E (full rendering)
