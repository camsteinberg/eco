// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import type { GenerationReceipt } from '../../lifecycle/generation-receipt';
import {
  buildCapturedFailure,
  capturedFailureToPromptSpec,
  HISTORY_CHAR_BUDGET,
  OUTPUT_CHAR_CAP,
  type BuildCaptureInput,
  type CaptureSourceMessage,
} from '../capture';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeMessages(): CaptureSourceMessage[] {
  return [
    { id: 'u1', role: 'user', content: 'hi there' },
    { id: 'a1', role: 'assistant', content: 'Hello! How can I help?' },
    { id: 'u2', role: 'user', content: 'what is the capital of france' },
    { id: 'a2', role: 'assistant', content: 'The capital ofFrance is Paris.' },
  ];
}

function makeReceipt(overrides?: Partial<GenerationReceipt>): GenerationReceipt {
  return {
    generationId: 'gen-1',
    generationRole: 'primary',
    modelId: 'candidate/qwen3.5-2b-onnx',
    timestamp: 1_770_000_000_000,
    templateName: 'chat_template.jinja',
    systemPromptHash: 'ab12cd34',
    samplingProfile: { temperature: 0.3, maxTokens: 2048, intent: 'explain' },
    promptTokens: 120,
    completionTokens: 42,
    durationMs: 1500,
    status: 'complete',
    ...overrides,
  };
}

function makeInput(overrides?: Partial<BuildCaptureInput>): BuildCaptureInput {
  return {
    messages: makeMessages(),
    failingMessageId: 'a2',
    tags: ['formatting'],
    note: 'fused words again',
    receipt: makeReceipt(),
    now: () => 1_770_000_100_000,
    generateId: () => 'cap-test-1',
    ...overrides,
  };
}

// ─── buildCapturedFailure ──────────────────────────────────────────────────

describe('buildCapturedFailure', () => {
  it('slices the conversation around the failing turn', () => {
    const capture = buildCapturedFailure(makeInput());
    expect(capture).not.toBeNull();
    expect(capture!.schemaVersion).toBe(1);
    expect(capture!.captureId).toBe('cap-test-1');
    expect(capture!.capturedAt).toBe(new Date(1_770_000_100_000).toISOString());
    expect(capture!.prompt).toBe('what is the capital of france');
    expect(capture!.failingOutput).toBe('The capital ofFrance is Paris.');
    expect(capture!.history).toEqual([
      { role: 'user', content: 'hi there' },
      { role: 'assistant', content: 'Hello! How can I help?' },
    ]);
    expect(capture!.historyTruncated).toBe(false);
    expect(capture!.tags).toEqual(['formatting']);
    expect(capture!.note).toBe('fused words again');
  });

  it('records provenance from the receipt (model, intent, sampling snapshot)', () => {
    const capture = buildCapturedFailure(makeInput());
    expect(capture!.modelId).toBe('candidate/qwen3.5-2b-onnx');
    expect(capture!.intent).toBe('explain');
    expect(capture!.receipt).toEqual({
      templateName: 'chat_template.jinja',
      systemPromptHash: 'ab12cd34',
      samplingProfile: { temperature: 0.3, maxTokens: 2048, intent: 'explain' },
      promptTokens: 120,
      completionTokens: 42,
      status: 'complete',
    });
  });

  it('handles a missing receipt: null provenance, capture still valid', () => {
    const capture = buildCapturedFailure(makeInput({ receipt: null }));
    expect(capture).not.toBeNull();
    expect(capture!.modelId).toBeNull();
    expect(capture!.intent).toBeNull();
    expect(capture!.receipt).toBeNull();
  });

  it('nulls an intent the ChatIntent union does not know', () => {
    const receipt = makeReceipt({
      samplingProfile: { temperature: 0.3, maxTokens: 2048, intent: 'bogus-intent' },
    });
    const capture = buildCapturedFailure(makeInput({ receipt }));
    expect(capture!.intent).toBeNull();
  });

  it('excludes system messages and empty turns from history', () => {
    const messages: CaptureSourceMessage[] = [
      { id: 's1', role: 'system', content: 'be helpful' },
      { id: 'u1', role: 'user', content: 'hi' },
      { id: 'a1', role: 'assistant', content: '' }, // errored/empty turn
      { id: 'u2', role: 'user', content: 'and now?' },
      { id: 'a2', role: 'assistant', content: 'bad answer' },
    ];
    const capture = buildCapturedFailure(makeInput({ messages, failingMessageId: 'a2' }));
    expect(capture!.history).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('truncates oldest history first and keeps the remainder user-first', () => {
    const big = 'x'.repeat(Math.ceil(HISTORY_CHAR_BUDGET / 2));
    const messages: CaptureSourceMessage[] = [
      { id: 'u1', role: 'user', content: big },
      { id: 'a1', role: 'assistant', content: big },
      { id: 'u2', role: 'user', content: 'short question' },
      { id: 'a2', role: 'assistant', content: 'short answer' },
      { id: 'u3', role: 'user', content: 'the failing prompt' },
      { id: 'a3', role: 'assistant', content: 'the failing output' },
    ];
    const capture = buildCapturedFailure(makeInput({ messages, failingMessageId: 'a3' }));
    expect(capture!.historyTruncated).toBe(true);
    // u1 dropped for budget; a1 dropped to keep alternation user-first.
    expect(capture!.history[0]).toEqual({ role: 'user', content: 'short question' });
    expect(capture!.history).toHaveLength(2);
  });

  it('caps the failing output and marks the cut', () => {
    const messages = makeMessages();
    messages[3] = { id: 'a2', role: 'assistant', content: 'y'.repeat(OUTPUT_CHAR_CAP + 500) };
    const capture = buildCapturedFailure(makeInput({ messages }));
    expect(capture!.failingOutput).toHaveLength(OUTPUT_CHAR_CAP + 1);
    expect(capture!.failingOutput.endsWith('…')).toBe(true);
  });

  it('carries up to three citations from the failing message', () => {
    const messages = makeMessages();
    messages[3] = {
      ...messages[3]!,
      citations: [
        { title: 'Paris', url: 'https://en.wikipedia.org/wiki/Paris', source: 'Wikipedia' },
        { title: 'B', url: 'https://example.com/b' },
        { title: 'C', url: 'https://example.com/c' },
        { title: 'D', url: 'https://example.com/d' },
      ],
    };
    const capture = buildCapturedFailure(makeInput({ messages }));
    expect(capture!.citations).toHaveLength(3);
    expect(capture!.citations[0]).toEqual({
      title: 'Paris',
      url: 'https://en.wikipedia.org/wiki/Paris',
      source: 'Wikipedia',
    });
    expect(capture!.citations[1]).toEqual({ title: 'B', url: 'https://example.com/b' });
  });

  it('returns null when the failing message is missing', () => {
    expect(buildCapturedFailure(makeInput({ failingMessageId: 'nope' }))).toBeNull();
  });

  it('returns null when the flagged message is not an assistant turn', () => {
    expect(buildCapturedFailure(makeInput({ failingMessageId: 'u2' }))).toBeNull();
  });

  it('returns null when the failing turn has no preceding user message', () => {
    const messages: CaptureSourceMessage[] = [
      { id: 'a0', role: 'assistant', content: 'unprompted greeting' },
    ];
    expect(buildCapturedFailure(makeInput({ messages, failingMessageId: 'a0' }))).toBeNull();
  });

  it('returns null when the failing assistant turn is empty', () => {
    const messages = makeMessages();
    messages[3] = { id: 'a2', role: 'assistant', content: '   ' };
    expect(buildCapturedFailure(makeInput({ messages }))).toBeNull();
  });
});

// ─── capturedFailureToPromptSpec ───────────────────────────────────────────

describe('capturedFailureToPromptSpec', () => {
  it('maps a capture onto a judge-scored multi-turn probe', () => {
    const capture = buildCapturedFailure(makeInput())!;
    const spec = capturedFailureToPromptSpec(capture);
    expect(spec.id).toBe('cap-test-1');
    expect(spec.category).toBe('captured');
    expect(spec.intent).toBe('explain');
    expect(spec.prompt).toBe('what is the capital of france');
    expect(spec.history).toEqual(capture.history);
    expect(spec.judge).toEqual(['coherence', 'taskFit']);
    expect(spec.notes).toContain('formatting');
    expect(spec.notes).toContain('fused words again');
    expect(spec.notes).toContain('candidate/qwen3.5-2b-onnx');
  });

  it('falls back to production intent classification when provenance is missing', () => {
    const capture = buildCapturedFailure(makeInput({ receipt: null }))!;
    const spec = capturedFailureToPromptSpec(capture);
    // Production routing (Wave 2.6 Stage 1): "what is the capital of france"
    // is a single-fact interrogative → brief shape → quick.
    expect(spec.intent).toBe('quick');
  });

  it('omits the history key entirely for a single-turn capture', () => {
    const messages: CaptureSourceMessage[] = [
      { id: 'u1', role: 'user', content: 'hello there friend' },
      { id: 'a1', role: 'assistant', content: 'a thin reply' },
    ];
    const capture = buildCapturedFailure(
      makeInput({ messages, failingMessageId: 'a1', receipt: null }),
    )!;
    const spec = capturedFailureToPromptSpec(capture);
    expect('history' in spec).toBe(false);
    // No receipt provenance; no EXPLAIN/CODE/… pattern and short → quick.
    expect(spec.intent).toBe('quick');
  });
});
