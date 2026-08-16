// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Stage 5a wiring contract — the local-AI branch in useChat composes:
 *
 *   getLocalAiSlot(slot).status === 'ready'
 *     ? createLocalAiLegacyInference().generate(messages, modelId, opts)
 *     : buildLocalReadinessFailureV2({ slot })
 *
 * useChat is not directly driven via `renderHook` in this codebase — its
 * exported helpers are unit-tested (see `useChat.test.ts`, `useChat-local.test.ts`,
 * `useChat-local-runtime-recovery.test.ts`) and end-to-end coverage runs via
 * Playwright. This file pins the v1-side composition by asserting each
 * collaborator is callable and produces the shapes the wired-in code expects.
 *
 * The shim itself is exhaustively tested in
 * `local-ai/adapters/__tests__/useChatLegacyShim.test.ts`. The V2 readiness
 * builder in `lib/__tests__/chat-turns.test.ts`. This file is the seam.
 *
 * PR-A-11 deleted the v1 runtime feature flag — the v1 branch is now the
 * only branch. The standalone flag-gate test that previously asserted
 * callable+boolean has been dropped.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildLocalReadinessFailureV2 } from '../../lib/chat-turns';
import type { SlotState } from '../../local-ai/lifecycle/slots';
import type { ModelConfig } from '../../local-ai/types';

vi.mock('../../local-ai/bootstrap', () => ({
  bootstrapLocalAi: vi.fn(async () => undefined),
}));

vi.mock('../../local-ai/catalog/catalog', () => ({
  getModel: (id: string): ModelConfig | null =>
    id === 'local/qwen3-0.6b'
      ? ({ id, friendlyName: 'Qwen3' } as unknown as ModelConfig)
      : null,
}));

vi.mock('../../local-ai/runtime/lifecycle', () => ({
  loadModel: vi.fn(async () => ({})),
  generate: vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      yield { kind: 'token', text: 'hello' };
      yield { kind: 'token', text: ' world' };
      yield { kind: 'done', completionTokens: 2, promptTokens: 4 };
    },
  })),
}));

beforeEach(() => {
  // Each test reads fresh shim state.
});

describe('Stage 5a wiring — readiness branch', () => {
  it('builds a readiness failure with friendly slot label when slot is empty', () => {
    const emptySlot: SlotState = {
      slot: 'eco-fast',
      modelId: null,
      model: null,
      status: 'empty',
    };
    const failure = buildLocalReadinessFailureV2({ slot: emptySlot });
    expect(failure.slotId).toBe('eco-fast');
    expect(failure.slotLabel).toBe('Eco');
    expect(failure.readinessStatus).toBe('not-downloaded');
    expect(failure.message).toMatch(/Settings → Models/);
  });

  it('builds a readiness failure with friendly model name when slot is preparing', () => {
    const preparingSlot: SlotState = {
      slot: 'eco-smart',
      modelId: 'local/qwen3-0.6b',
      model: { id: 'local/qwen3-0.6b', friendlyName: 'Qwen3' } as unknown as ModelConfig,
      status: 'preparing',
    };
    const failure = buildLocalReadinessFailureV2({ slot: preparingSlot });
    expect(failure.modelName).toBe('Qwen3');
    expect(failure.readinessStatus).toBe('partial');
    expect(failure.slotId).toBe('eco-smart');
  });
});

describe('Stage 5a wiring — shim composition', () => {
  it('createLocalAiLegacyInference produces a ReadableStream from a ready slot', async () => {
    const { createLocalAiLegacyInference } = await import(
      '../../local-ai/adapters/useChatLegacyShim'
    );
    const shim = createLocalAiLegacyInference();

    const stream = shim.generate(
      [{ role: 'user', content: 'hi' }],
      'local/qwen3-0.6b',
      { max_new_tokens: 32 },
    );

    expect(stream).toBeInstanceOf(ReadableStream);

    const reader = stream.getReader();
    const out: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
    expect(out.join('')).toBe('hello world');
  });

  it('shim writes the same usage shape useChat will read post-generation', async () => {
    const { createLocalAiLegacyInference } = await import(
      '../../local-ai/adapters/useChatLegacyShim'
    );
    const { getLastUsage, _resetUsageStoreForTesting } = await import(
      '../../local-ai/runtime/usage-store'
    );
    _resetUsageStoreForTesting();
    const shim = createLocalAiLegacyInference();

    const stream = shim.generate(
      [{ role: 'user', content: 'x' }],
      'local/qwen3-0.6b',
      { max_new_tokens: 64 },
    );
    const reader = stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    const usage = getLastUsage();
    expect(usage).toEqual({ promptTokens: 4, completionTokens: 2, maxTokens: 64 });
  });
});

