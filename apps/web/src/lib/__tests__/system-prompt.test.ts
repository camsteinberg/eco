// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest';
import { getOnDeviceSystemPrompt } from '../system-prompt';
import { DisclaimerFilter } from '../../local-ai/runtime/output-filter';

// ---------------------------------------------------------------------------
// On-device system prompt
// ---------------------------------------------------------------------------

describe('getOnDeviceSystemPrompt', () => {
  // -- Lean prompt content --

  it('contains Eco identity', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).toContain('You are Eco');
  });

  it('contains markdown formatting directive', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).toContain('markdown');
  });

  it('contains the conversational-register directive', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).toContain('conversational');
  });

  it('gives the model a TRUE nameable identity ("compact open model") so "what model are you?" gets an honest echo', () => {
    // Observed live without this: "I run on the latest version of the LLaMA 3
    // model" and "I'm running on a Raspberry Pi" — the question begs for a
    // name, and the prompt previously offered none to echo.
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).toContain('compact open model');
  });

  it('contains true identity facts (private, on-device) so direct identity/privacy questions get true answers', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).toContain('private AI');
    expect(prompt).toContain('on this device');
  });

  it('does NOT contain a "headings" cue or literal "answer" phrasing (document-mode regression guard)', () => {
    // The previous directive ("use headings … Lead with the answer") was
    // literalized by the 1.2B default into replies opening with an H1 "Answer".
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).not.toMatch(/heading/i);
    expect(prompt).not.toMatch(/\banswer\b/i);
  });

  // -- No inline examples (they caused content leakage on sub-2B models) --

  it('does NOT contain a ## header (no inline examples)', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).not.toMatch(/^## /m);
  });

  it('does NOT contain triple-backtick code blocks (no inline examples)', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).not.toContain('```');
  });

  // -- Length bound: lean prompt, now with the richness directive (chat #7) --
  // Widened from 250 → 700 chars when the depth-matching directive replaced
  // "as short as the question allows" (which overcorrected into terse replies).
  // Still a bloat guard: ~700 chars ≈ 160 tokens of a 4096 context.

  it('prompt length stays lean (100-700 chars)', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt.length).toBeGreaterThan(100);
    expect(prompt.length).toBeLessThan(700);
  });

  // -- Richness directive (chat #7): depth matched to the question --

  it('asks for depth matched to the question instead of minimal length', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).toContain('Match depth to the question');
    expect(prompt).not.toMatch(/as short as/i);
  });

  it('tells the model to follow explicit user format/length instructions exactly (strict-ask guard)', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).toMatch(/format or length instructions, follow them exactly/);
  });

  // -- Regression guards: content leakage canaries --

  it('does NOT contain "vegetarian", "recipe", or "dietary" (content leakage canary)', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).not.toMatch(/vegetarian/i);
    expect(prompt).not.toMatch(/recipe/i);
    expect(prompt).not.toMatch(/dietary/i);
  });

  it('does NOT contain UI-mechanics phrasing ("running locally", "open source", "in this browser", "download", "WebGPU")', () => {
    // Posture updated 2026-06-09: minimal TRUE identity facts (private,
    // on-device) are now deliberately included — without them the model invents
    // its identity and privacy story under direct questioning. UI mechanics
    // stay out: those leak as content without improving truthful answers.
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).not.toMatch(/running locally/i);
    expect(prompt).not.toMatch(/open.source/i);
    expect(prompt).not.toMatch(/in this browser/i);
    expect(prompt).not.toMatch(/download/i);
    expect(prompt).not.toMatch(/webgpu/i);
  });

  // -- Catalog suffix integration --

  it('does not leak prompt-level /no_think into Qwen3 models', () => {
    const prompt = getOnDeviceSystemPrompt('local/qwen3-0.6b');
    expect(prompt).not.toContain('/no_think');
  });

  it('appends systemDirective for catalog models that have one (Phi-3 Mini)', () => {
    const prompt = getOnDeviceSystemPrompt('local/phi3-mini-4k-q4f16');
    expect(prompt).toContain('Answer directly');
    expect(prompt).toContain('Do not reveal hidden reasoning');
  });

  it('returns base prompt only for non-catalog models (no legacy suffix lookup)', () => {
    const prompt = getOnDeviceSystemPrompt('local/smollm3-3b');
    expect(prompt).not.toContain('/system_override');
    expect(prompt).not.toContain('/no_think');
  });

  it('returns base prompt for catalog models without systemDirective (Bonsai q4)', () => {
    const prompt = getOnDeviceSystemPrompt('local/qwen3-0.6b');
    expect(prompt).not.toContain('/no_think');
    expect(prompt).not.toContain('Answer directly');
  });

  it('does NOT append directives for non-catalog models', () => {
    const prompt = getOnDeviceSystemPrompt('local/rwkv7-1.5b');
    expect(prompt).not.toContain('/no_think');
  });

  it('does NOT append /no_think when no modelId given', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).not.toContain('/no_think');
  });

  it('contains no negative behavioral instructions', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).not.toMatch(/\bdo not\b/i);
    expect(prompt).not.toMatch(/\bdon't\b/i);
    expect(prompt).not.toMatch(/\bnever\b/i);
  });

  it('contains no emoji', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).not.toMatch(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u,
    );
  });
});

// ---------------------------------------------------------------------------
// DisclaimerFilter
// ---------------------------------------------------------------------------

describe('DisclaimerFilter', () => {
  it('strips "As an AI, I don\'t have personal experiences, but..."', () => {
    const filter = new DisclaimerFilter();
    // Feed the disclaimer all at once (enough to trigger check)
    const result =
      filter.process("As an AI, I don't have personal experiences, but here's what I know about cooking.") +
      filter.flush();
    expect(result).toBe("Here's what I know about cooking.");
  });

  it('strips "As an AI language model, I cannot have opinions. However,"', () => {
    const filter = new DisclaimerFilter();
    const result =
      filter.process('As an AI language model, I cannot have opinions. However, the data suggests that cats are popular.') +
      filter.flush();
    expect(result).toContain('the data suggests');
    expect(result).not.toContain('As an AI');
  });

  it('strips "As an AI assistant, I do not have feelings, but"', () => {
    const filter = new DisclaimerFilter();
    const result =
      filter.process('As an AI assistant, I do not have feelings, but I can help you with that!') +
      filter.flush();
    expect(result).toBe('I can help you with that!');
  });

  it('does NOT strip "As an aside, ..." (false positive check)', () => {
    const filter = new DisclaimerFilter();
    const input = 'As an aside, this is a really interesting topic that deserves more attention in the literature.';
    const result = filter.process(input) + filter.flush();
    expect(result).toBe(input);
  });

  it('does NOT strip mid-sentence AI mentions', () => {
    const filter = new DisclaimerFilter();
    const input = "The concept of AI is fascinating. As an AI, systems like me process language using neural networks and that's great.";
    const result = filter.process(input) + filter.flush();
    expect(result).toBe(input);
  });

  it('capitalizes first letter after stripping', () => {
    const filter = new DisclaimerFilter();
    const result =
      filter.process("As an AI, I don't have personal experiences, but it depends on context and other factors in the real world.") +
      filter.flush();
    expect(result[0]).toMatch(/[A-Z]/);
  });

  it('passes through normal text unchanged', () => {
    const filter = new DisclaimerFilter();
    const input = 'The capital of France is Paris. It has been the capital since the 10th century and remains a cultural hub.';
    const result = filter.process(input) + filter.flush();
    expect(result).toBe(input);
  });

  it('handles empty string', () => {
    const filter = new DisclaimerFilter();
    const result = filter.process('') + filter.flush();
    expect(result).toBe('');
  });

  it('streams normal openings immediately instead of adding artificial latency', () => {
    const filter = new DisclaimerFilter();
    let output = '';
    output += filter.process('Hello ');
    expect(output).toBe('Hello ');
    output += filter.process('world, this is a normal response that should pass through completely unchanged.');
    output += filter.flush();
    expect(output).toContain('Hello world');
  });

  it('passes through after initial check (streaming)', () => {
    const filter = new DisclaimerFilter();
    // First: accumulate enough to pass check
    let output = '';
    output += filter.process('The answer is that you need to consider multiple factors when making this decision about your code.');
    output += filter.process(' And also think about testing.');
    output += filter.flush();
    expect(output).toContain('The answer is');
    expect(output).toContain('And also think about testing.');
  });
});
