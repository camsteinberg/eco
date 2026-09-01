// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Unit tests for the pure prompt assembler.
 *
 * The cross-path "nothing changed" proof lives in
 * `src/__tests__/prompt-equivalence` (192 recorded cells). These tests pin the
 * things that file cannot reach: the ordering guarantees, the tool-note branch
 * (no tool fires in the equivalence harness), and purity.
 */

import { describe, it, expect } from 'vitest';

import { getOnDeviceSystemPrompt } from '../../../lib/system-prompt';
import { buildBranchRecaps } from '../../../lib/detail-recap';
import {
  assemble,
  appendTurnDirective,
  buildSystemPrompt,
  latestTurnIntent,
  resolveOptions,
  type PromptMessage,
} from '../assemble';

const MODEL_ID = 'local/qwen3-0.6b';
const NO_RECAPS = { figures: [], details: [] };

function turns(...content: string[]): PromptMessage[] {
  return content.map((c, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: c }));
}

function base(overrides: Partial<Parameters<typeof assemble>[0]> = {}) {
  return assemble({
    modelId: MODEL_ID,
    messages: turns('what is the capital of France'),
    branchRecaps: NO_RECAPS,
    customInstructions: '',
    ...overrides,
  });
}

describe('buildSystemPrompt', () => {
  it('is the on-device prompt when there are no custom instructions', () => {
    expect(buildSystemPrompt(MODEL_ID, '')).toBe(getOnDeviceSystemPrompt());
  });

  it('appends trimmed custom instructions after a blank line', () => {
    expect(buildSystemPrompt(MODEL_ID, '  Be concise.  ')).toBe(
      `${getOnDeviceSystemPrompt()}\n\nBe concise.`,
    );
  });

  it('ignores whitespace-only custom instructions', () => {
    expect(buildSystemPrompt(MODEL_ID, '   \n  ')).toBe(getOnDeviceSystemPrompt());
  });
});

describe('appendTurnDirective', () => {
  it('appends to the LAST user turn, not the last message', () => {
    const messages = turns('first', 'reply', 'second');
    const out = appendTurnDirective(messages, 'Answer in one line.');
    expect(out[2]!.content).toBe('second\n\nAnswer in one line.');
    expect(out[0]!.content).toBe('first');
  });

  it('never mutates the input list (the directive must stay out of storage)', () => {
    const messages = turns('hello');
    const snapshot = JSON.stringify(messages);
    appendTurnDirective(messages, 'Be brief.');
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it('is a no-op for a blank directive or a list with no user turn', () => {
    expect(appendTurnDirective(turns('hello'), '   ')[0]!.content).toBe('hello');
    const assistantOnly: PromptMessage[] = [{ role: 'assistant', content: 'hi' }];
    expect(appendTurnDirective(assistantOnly, 'Be brief.')[0]!.content).toBe('hi');
  });
});

describe('assemble — message shape', () => {
  it('puts the system prompt first and the turns after it', () => {
    const plan = base({ messages: turns('a', 'b', 'c') });
    expect(plan.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(plan.messages[0]!.content).toBe(plan.systemPrompt);
  });

  it('exposes the turns without the system message as `conversation`', () => {
    const plan = base({ messages: turns('a', 'b', 'c') });
    expect(plan.conversation).toEqual(plan.messages.slice(1));
  });

  it('carries custom instructions into the system message', () => {
    const plan = base({ customInstructions: 'Always answer in British English.' });
    expect(plan.systemPrompt).toContain('Always answer in British English.');
  });

  it('uses a caller-supplied system prompt verbatim, ignoring custom instructions', () => {
    const plan = base({ systemPrompt: 'ARM PROMPT', customInstructions: 'Be terse.' });
    expect(plan.systemPrompt).toBe('ARM PROMPT');
  });
});

describe('assemble — the tool note', () => {
  it('joins the tool note onto the system prompt with a blank line', () => {
    const plan = base({ toolSystemNote: '17 * 23 = 391' });
    expect(plan.systemPrompt).toBe(`${getOnDeviceSystemPrompt()}\n\n17 * 23 = 391`);
  });

  it('leaves the conversation turns untouched — the note is system-side only', () => {
    const messages = turns('what is 17 * 23');
    const withNote = assemble({
      modelId: MODEL_ID,
      messages,
      branchRecaps: NO_RECAPS,
      customInstructions: '',
      toolSystemNote: '17 * 23 = 391',
    });
    const without = assemble({
      modelId: MODEL_ID,
      messages,
      branchRecaps: NO_RECAPS,
      customInstructions: '',
    });
    expect(withNote.conversation).toEqual(without.conversation);
    expect(withNote.options).toEqual(without.options);
  });

  it('composes the note on top of custom instructions, in that order', () => {
    const plan = base({ customInstructions: 'Be terse.', toolSystemNote: 'NOTE' });
    expect(plan.systemPrompt).toBe(`${getOnDeviceSystemPrompt()}\n\nBe terse.\n\nNOTE`);
  });
});

describe('assemble — ordering guarantees', () => {
  // The load-bearing one: recaps go on LAST, after every decision the turn's own
  // text makes. Classifying recapped text was measured to flip a corpus turn's
  // intent, which would resolve different sampling options.
  it('classifies the turn BEFORE recaps are appended', () => {
    const branch = turns(
      'im booking a table at the italian on bridgford road for sunday 8th march, 1pm, six of us',
      'Sounds good.',
      'draft the message to the group',
    );
    const recaps = buildBranchRecaps(branch);
    const plan = assemble({
      modelId: MODEL_ID,
      messages: branch,
      branchRecaps: recaps,
      customInstructions: '',
    });
    // The recap really did attach (otherwise this test proves nothing).
    expect(plan.conversation[2]!.content).not.toBe(branch[2]!.content);
    expect(plan.conversation[2]!.content).toContain('Details I gave earlier in this chat');
    // ...and the intent is the one the un-recapped turn classifies to.
    expect(plan.turnIntent).toBe(latestTurnIntent(branch));
  });

  it('classifies the turn AFTER the directive is composed onto it', () => {
    const messages = turns('summarise this');
    const directive = 'Explain in depth, with reasons and worked detail throughout.';
    const plan = assemble({
      modelId: MODEL_ID,
      messages,
      branchRecaps: NO_RECAPS,
      customInstructions: '',
      turnDirective: directive,
    });
    expect(plan.turnIntent).toBe(latestTurnIntent(appendTurnDirective(messages, directive)));
    expect(plan.conversation[0]!.content).toBe(`summarise this\n\n${directive}`);
  });

  it('a forced intent overrides classification without touching the classifiers', () => {
    const messages = turns('what is the capital of France');
    const forced = assemble({
      modelId: MODEL_ID,
      messages,
      branchRecaps: NO_RECAPS,
      customInstructions: '',
      intent: 'deep',
    });
    expect(forced.turnIntent).toBe('deep');
    expect(forced.options).toEqual(resolveOptions({ modelId: MODEL_ID, messages, intent: 'deep' }));
  });
});

describe('assemble — the offline-continue partial', () => {
  it('appends the partial as a trailing assistant turn and sets continueFinalMessage', () => {
    const plan = base({ partialAssistantContent: 'The first part of the answer was' });
    const last = plan.messages[plan.messages.length - 1]!;
    expect(last).toEqual({ role: 'assistant', content: 'The first part of the answer was' });
    expect(plan.options.continueFinalMessage).toBe(true);
    // `conversation` stays the turns only — the partial is a runtime resumption,
    // not part of the branch.
    expect(plan.conversation.some((m) => m.content.startsWith('The first part'))).toBe(false);
  });

  it('ignores a blank partial entirely', () => {
    const plan = base({ partialAssistantContent: '   ' });
    expect(plan.options.continueFinalMessage).toBeUndefined();
    expect(plan.messages[plan.messages.length - 1]!.role).toBe('user');
  });
});

describe('assemble — options', () => {
  it('resolves a per-model sampling row', () => {
    const plan = base();
    expect(plan.options.max_new_tokens).toBeGreaterThan(0);
    expect(typeof plan.options.temperature).toBe('number');
  });

  it('still varies by intent (the Phase M collapse is deliberately NOT done here)', () => {
    const messages = turns('x');
    const brief = resolveOptions({ modelId: MODEL_ID, messages, intent: 'quick' });
    const deep = resolveOptions({ modelId: MODEL_ID, messages, intent: 'deep' });
    expect(brief).not.toEqual(deep);
  });

  it('omits absent sampling fields rather than emitting undefined', () => {
    const plan = base();
    for (const value of Object.values(plan.options)) expect(value).not.toBeUndefined();
  });
});

describe('assemble — purity', () => {
  it('does not mutate its inputs', () => {
    const messages = turns('a', 'b', 'c');
    const recaps = buildBranchRecaps(messages);
    const before = JSON.stringify({ messages, recaps });
    assemble({
      modelId: MODEL_ID,
      messages,
      branchRecaps: recaps,
      customInstructions: 'Be terse.',
      turnDirective: 'Be brief.',
      toolSystemNote: 'NOTE',
      partialAssistantContent: 'partial',
    });
    expect(JSON.stringify({ messages, recaps })).toBe(before);
  });

  it('is deterministic for identical inputs', () => {
    expect(base()).toEqual(base());
  });
});
