// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { Template } from '@huggingface/jinja';
import { patchChatTemplateForKvReuse } from '../template-patches';
import { QWEN35_CHAT_TEMPLATE } from './fixtures/qwen35-chat-template';

/**
 * Render exactly the way the worker does: apply_chat_template with
 * tokenize:false, add_generation_prompt:true, enable_thinking:false
 * (see workers/local-ai-transformers-worker.ts handleGenerate).
 */
function render(
  template: string,
  messages: { role: string; content: string }[],
  options: { enable_thinking?: boolean } = {},
): string {
  return new Template(template).render({
    messages,
    add_generation_prompt: true,
    enable_thinking: options.enable_thinking ?? false,
  });
}

const SYSTEM = 'You are Eco, a helpful assistant.';
const EMPTY_THINK = '<think>\n\n</think>\n\n';

describe('patchChatTemplateForKvReuse', () => {
  it('patches the pinned Qwen3.5 template exactly once', () => {
    const result = patchChatTemplateForKvReuse(QWEN35_CHAT_TEMPLATE);
    expect(result.patched).toBe(true);
    // The history-assistant statement now renders the empty think block…
    expect(result.template).toContain(
      "{{- '<|im_start|>' + message.role + '\\n<think>\\n\\n</think>\\n\\n' + content }}",
    );
    // …and the vendor statement is gone.
    expect(result.template).not.toContain(
      "{{- '<|im_start|>' + message.role + '\\n' + content }}",
    );
    // Surgical: only the one statement changed.
    expect(result.template.length).toBe(
      QWEN35_CHAT_TEMPLATE.length + '<think>\\n\\n</think>\\n\\n'.length,
    );
  });

  it('is self-disabling on already-patched input (idempotence)', () => {
    const once = patchChatTemplateForKvReuse(QWEN35_CHAT_TEMPLATE);
    const twice = patchChatTemplateForKvReuse(once.template);
    expect(twice.patched).toBe(false);
    expect(twice.template).toBe(once.template);
  });

  it('leaves templates without the non-thinking generation-prompt marker alone', () => {
    // ChatML-ish template that HAS the history statement but no think
    // machinery — there is no asymmetry to fix, so the patch must not fire.
    const chatml =
      "{%- for message in messages %}{{- '<|im_start|>' + message.role + '\\n' + content }}{{- '<|im_end|>\\n' }}{%- endfor %}";
    const result = patchChatTemplateForKvReuse(chatml);
    expect(result.patched).toBe(false);
    expect(result.template).toBe(chatml);
  });

  it('refuses ambiguous templates where the statement appears more than once', () => {
    const stmt = "{{- '<|im_start|>' + message.role + '\\n' + content }}";
    const ambiguous = `{{- '<think>\\n\\n</think>\\n\\n' }}${stmt}${stmt}`;
    const result = patchChatTemplateForKvReuse(ambiguous);
    expect(result.patched).toBe(false);
    expect(result.template).toBe(ambiguous);
  });

  it('leaves a template with no matching statement untouched', () => {
    const other = "{%- for m in messages %}{{ m.content }}{%- endfor %}";
    expect(patchChatTemplateForKvReuse(other)).toEqual({
      template: other,
      patched: false,
    });
  });
});

describe('Qwen3.5 render contract (the KV strict-prefix property)', () => {
  const turn1 = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: 'write a two line poem about rain' },
  ];
  const reply = 'Soft drops on the windowpane,\nThe sky writes silver lines of rain.';
  const turn2 = [
    ...turn1,
    { role: 'assistant', content: reply },
    { role: 'user', content: 'now write one about sunshine' },
  ];

  it('documents the vendor bug: the live turn-1 stream is NOT a prefix of the turn-2 render', () => {
    const r1 = render(QWEN35_CHAT_TEMPLATE, turn1);
    // What the model actually consumed+produced (and what the worker cached):
    const liveStream = r1 + reply + '<|im_end|>';
    const r2 = render(QWEN35_CHAT_TEMPLATE, turn2);
    expect(r1.endsWith(EMPTY_THINK)).toBe(true); // injected into the generation prompt…
    expect(r2.startsWith(liveStream)).toBe(false); // …but absent from the history re-render.
  });

  it('patched: the live turn-1 stream IS a string prefix of the turn-2 render', () => {
    const { template, patched } = patchChatTemplateForKvReuse(QWEN35_CHAT_TEMPLATE);
    expect(patched).toBe(true);
    const r1 = render(template, turn1);
    const liveStream = r1 + reply + '<|im_end|>';
    const r2 = render(template, turn2);
    expect(r2.startsWith(liveStream)).toBe(true);
  });

  it('patched: the property holds again from turn 2 to turn 3', () => {
    const { template } = patchChatTemplateForKvReuse(QWEN35_CHAT_TEMPLATE);
    const r2 = render(template, turn2);
    const reply2 = 'Gold spills over morning hills,\nWarm light every shadow fills.';
    const liveStream2 = r2 + reply2 + '<|im_end|>';
    const turn3 = [
      ...turn2,
      { role: 'assistant', content: reply2 },
      { role: 'user', content: 'which one do you prefer?' },
    ];
    const r3 = render(template, turn3);
    expect(r3.startsWith(liveStream2)).toBe(true);
  });

  it('patched: the generation prompt itself is unchanged (still ends with the empty think block)', () => {
    const { template } = patchChatTemplateForKvReuse(QWEN35_CHAT_TEMPLATE);
    const r1 = render(template, turn1);
    expect(r1.endsWith(`<|im_start|>assistant\n${EMPTY_THINK}`)).toBe(true);
    // And byte-identical to the vendor render for a first turn (no history
    // assistant message — the patched branch never fires).
    expect(r1).toBe(render(QWEN35_CHAT_TEMPLATE, turn1));
  });

  it('patched: thinking mode is untouched', () => {
    const { template } = patchChatTemplateForKvReuse(QWEN35_CHAT_TEMPLATE);
    const r1 = render(template, turn1, { enable_thinking: true });
    expect(r1.endsWith('<|im_start|>assistant\n<think>\n')).toBe(true);
  });

  it('patched: history content carrying a real think block still renders the EMPTY block (no duplication)', () => {
    const { template } = patchChatTemplateForKvReuse(QWEN35_CHAT_TEMPLATE);
    const withThink = [
      ...turn1,
      { role: 'assistant', content: '<think>hidden reasoning</think>\nThe poem.' },
      { role: 'user', content: 'another' },
    ];
    const r = render(template, withThink);
    expect(r).toContain(`<|im_start|>assistant\n${EMPTY_THINK}The poem.<|im_end|>`);
    expect(r).not.toContain('hidden reasoning');
  });
});
