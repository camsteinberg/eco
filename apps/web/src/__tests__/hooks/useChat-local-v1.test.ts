// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Stage 5a wiring contract — the local-AI branch in useChat composes:
 *
 *   getLocalAiSlot(slot).status === 'ready'
 *     ? stream(messages, modelId, opts)
 *     : buildLocalReadinessFailureV2({ slot })
 *
 * useChat is not directly driven via `renderHook` in this codebase — its
 * exported helpers are unit-tested (see `useChat.test.ts`, `useChat-local.test.ts`,
 * `useChat-local-runtime-recovery.test.ts`) and end-to-end coverage runs via
 * Playwright. This file pins the v1-side composition by asserting each
 * collaborator is callable and produces the shapes the wired-in code expects.
 *
 * `stream()` itself is exhaustively tested in
 * `local-ai/runtime/__tests__/stream.test.ts`. The V2 readiness builder in
 * `lib/__tests__/chat-turns.test.ts`. This file is the seam.
 *
 * PR-A-11 deleted the v1 runtime feature flag — the v1 branch is now the
 * only branch. The standalone flag-gate test that previously asserted
 * callable+boolean has been dropped.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildLocalReadinessFailureV2 } from '../../lib/chat-turns';
import type { SlotState } from '../../local-ai/lifecycle/slots';
import type { ModelConfig } from '../../local-ai/types';
import type { TokenEvent } from '../../local-ai/runtime/types';

vi.mock('../../local-ai/bootstrap', () => ({
  bootstrapLocalAi: vi.fn(async () => undefined),
}));

// The REAL catalog: the branded name under test is the catalog entry's own
// `display` block, so mocking it out would make the assertion tautological.
vi.mock('../../local-ai/catalog/catalog', async () =>
  vi.importActual('../../local-ai/catalog/catalog'),
);

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
    expect(failure.message).toMatch(/will send itself/);
  });

  it('builds a readiness failure with friendly model name when slot is preparing', () => {
    const preparingSlot: SlotState = {
      slot: 'eco-smart',
      modelId: 'local/qwen3-0.6b',
      // vendor + sizeGB are type-guaranteed on a real ModelConfig and the
      // display mapping reads both; the fixture must carry them.
      model: {
        id: 'local/qwen3-0.6b',
        friendlyName: 'Qwen3',
        vendor: 'Qwen',
        sizeGB: 0.6,
      } as unknown as ModelConfig,
      status: 'preparing',
    };
    const failure = buildLocalReadinessFailureV2({ slot: preparingSlot });
    // The branded display name, matching every choice surface.
    expect(failure.modelName).toBe('Eco Compact (Qwen)');
    expect(failure.readinessStatus).toBe('partial');
    expect(failure.slotId).toBe('eco-smart');
  });
});

describe('Stage 5a wiring — stream composition', () => {
  it('stream() produces token events for a model bound to a ready slot', async () => {
    const { stream } = await import('../../local-ai/runtime/stream');

    const events: TokenEvent[] = [];
    for await (const event of stream([{ role: 'user', content: 'hi' }], 'local/qwen3-0.6b', {
      maxTokens: 32,
    })) {
      events.push(event);
    }

    expect(
      events
        .filter((e): e is Extract<TokenEvent, { kind: 'token' }> => e.kind === 'token')
        .map((e) => e.text)
        .join(''),
    ).toBe('hello world');
    // And it terminates with the `done` event useChat reads usage off — the
    // successor to "is a ReadableStream", which was the old shape assertion.
    expect(events.at(-1)?.kind).toBe('done');
  });

  it('carries the usage useChat will read straight off the terminating done event', async () => {
    const { stream } = await import('../../local-ai/runtime/stream');
    const { usageFromDone } = await import('../../local-ai/runtime/usage');

    let done: Extract<TokenEvent, { kind: 'done' }> | null = null;
    for await (const event of stream([{ role: 'user', content: 'x' }], 'local/qwen3-0.6b', {
      maxTokens: 64,
    })) {
      if (event.kind === 'done') done = event;
    }

    // The shape useChat writes onto the message and the receipt: the adapter's
    // counts plus the budget THIS turn requested.
    expect(usageFromDone(done, 64)).toEqual({
      promptTokens: 4,
      completionTokens: 2,
      maxTokens: 64,
      // Where the runtime's window started (R5a) — nothing was evicted here.
      windowStartIndex: 0,
    });
  });
});

