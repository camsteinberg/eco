// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Answer-shape classifier — unit pins (Wave 2.6 Stage 1).
 *
 * Every signal earns its place via these fixtures (drawn from the shape probe
 * set + the chat-intent regression corpus). Order-of-guards behavior is
 * pinned explicitly: explicit instructions beat everything; single facts beat
 * teaching; teaching beats the follow-up/fragment guards.
 */

import { describe, expect, it } from 'vitest';
import { hasExplicitFormatInstruction, inferAnswerShape, isSocialTurn } from '../answer-shape';

const inThread = { hasPriorTurns: true };

describe('inferAnswerShape — brief guards', () => {
  it('explicit format/length instructions are absolute (instructions win)', () => {
    expect(inferAnswerShape('summarize what a vpn does in one sentence')).toBe('brief');
    expect(inferAnswerShape('explain photosynthesis in 2 sentences')).toBe('brief');
    expect(inferAnswerShape('What is 17 times 24? Reply with just the number.')).toBe('brief');
    expect(inferAnswerShape('Reply with only the word READY and nothing else.')).toBe('brief');
    expect(inferAnswerShape('List exactly three fruits, one per line, with no other text.')).toBe('brief');
    expect(inferAnswerShape('Say only the word OK and stop.')).toBe('brief');
    expect(inferAnswerShape('Return a JSON object for Sam. Respond with JSON only.')).toBe('brief');
    expect(inferAnswerShape('Answer in exactly one sentence: why is the sky blue?')).toBe('brief');
  });

  it('single-fact interrogatives stay brief (the anti-padding guard)', () => {
    expect(inferAnswerShape('what is the capital of australia')).toBe('brief');
    expect(inferAnswerShape('who wrote the great gatsby')).toBe('brief');
    expect(inferAnswerShape('when did world war 2 end')).toBe('brief');
    expect(inferAnswerShape('where was mark zuckerberg born')).toBe('brief');
    expect(inferAnswerShape('who was cleopatra')).toBe('brief');
    expect(inferAnswerShape('when did the berlin wall fall')).toBe('brief');
    expect(inferAnswerShape('how tall is the eiffel tower')).toBe('brief');
    // Apostrophe-free real-user typing still matches.
    expect(inferAnswerShape('whats the capital of france')).toBe('brief');
    // Longer but still a pure lookup (within the word bound).
    expect(inferAnswerShape('What is the population of the town of Briznor Hollow as of 2027?')).toBe('brief');
  });

  it('single-fact vetoes: comparisons and plural/process asks deserve development', () => {
    expect(inferAnswerShape('whats the difference between a roth ira and a 401k')).toBe('focused');
    expect(inferAnswerShape("what's the difference between tea and coffee")).toBe('focused');
    // "ways" veto → falls through to the teaching plurality signal.
    expect(inferAnswerShape('what are some ways to make my resume stand out')).toBe('teaching');
  });

  it('short anaphoric follow-ups in a thread match the register (brief)', () => {
    expect(inferAnswerShape('make day 3 harder', inThread)).toBe('brief');
    expect(inferAnswerShape('what about doing it in an apartment?', inThread)).toBe('brief');
    expect(inferAnswerShape('thanks, can you make that into a checklist', inThread)).toBe('brief');
  });

  it('the follow-up guard needs the thread context', () => {
    expect(inferAnswerShape('can you make that one shorter', inThread)).toBe('brief');
    // Same text on a first turn: no thread → interrogative opener → focused.
    expect(inferAnswerShape('can you make that one shorter')).toBe('focused');
  });

  it('bare non-social fragments stay brief', () => {
    expect(inferAnswerShape('capital of france?')).toBe('brief');
    expect(inferAnswerShape('build me a sandwich')).toBe('brief');
  });
});

describe('inferAnswerShape — social turns', () => {
  it('classifies greetings, thanks, acknowledgments, and farewells as social', () => {
    for (const text of [
      'hello',
      'Hello',
      'hi',
      'hey',
      'hey there',
      'good morning',
      'good evening',
      'howdy',
      'thanks!',
      'thank you',
      'thank you so much',
      'thanks a lot',
      'appreciate it',
      'cheers',
      'ok',
      'okay',
      'cool',
      'got it',
      'sounds good',
      'awesome',
      'perfect',
      'bye',
      'goodbye',
      'see you',
      'take care',
      'good night',
    ]) {
      expect(inferAnswerShape(text), text).toBe('social');
    }
  });

  it('stays conservative: a short turn carrying a real question or task is NOT social', () => {
    // The negative case from the brief: a greeting glued to a lookup must
    // route on the lookup, never suppress as social.
    expect(inferAnswerShape("hi, what's the capital of france?")).toBe('focused');
    // A greeting glued to a task is not social either (substance remains).
    expect(inferAnswerShape('hey can you write me a poem')).not.toBe('social');
  });

  it('does not misread task/fact fragments as social', () => {
    // These share short length with greetings but carry substance.
    expect(inferAnswerShape('capital of france?')).toBe('brief');
    expect(inferAnswerShape('build me a sandwich')).toBe('brief');
    expect(inferAnswerShape('what is 2+2')).toBe('brief');
    expect(inferAnswerShape('fix this bug')).toBe('brief');
  });

  it('isSocialTurn is a pure text predicate (the KV-suppression contract)', () => {
    expect(isSocialTurn('Hello')).toBe(true);
    expect(isSocialTurn('thanks so much!')).toBe(true);
    expect(isSocialTurn('ok cool')).toBe(true);
    // Substance present → not social.
    expect(isSocialTurn("hi, what's the capital of france?")).toBe(false);
    expect(isSocialTurn('what is the capital of australia')).toBe(false);
    expect(isSocialTurn('teach me how to invest')).toBe(false);
    // Deterministic for identical inputs.
    expect(isSocialTurn('Hello')).toBe(isSocialTurn('Hello'));
  });
});

describe('inferAnswerShape — teaching signals', () => {
  it('teach/skill speech-acts', () => {
    expect(inferAnswerShape('please teach me how to invest')).toBe('teaching');
    expect(inferAnswerShape('how do i get better at cooking')).toBe('teaching');
    expect(inferAnswerShape('how do i get better at public speaking')).toBe('teaching');
    expect(inferAnswerShape('how can i sleep better')).toBe('teaching');
    expect(inferAnswerShape('walk me through setting up a monthly budget')).toBe('teaching');
    expect(inferAnswerShape('help me figure out how to study for finals')).toBe('teaching');
  });

  it('goal framing (apostrophe-free included), with a learn/do verb required', () => {
    expect(inferAnswerShape('i want to learn spanish but dont know where to start')).toBe('teaching');
    expect(inferAnswerShape('im trying to get into running')).toBe('teaching');
    // Goal phrase WITHOUT a learn/do verb is a fact lookup, not a course.
    expect(inferAnswerShape('i want to know who wrote 1984')).toBe('brief');
  });

  it('plurality-of-options markers', () => {
    expect(inferAnswerShape('give me some tips on negotiating a raise')).toBe('teaching');
    expect(inferAnswerShape('any tips?', inThread)).toBe('teaching');
  });

  it('explicit depth words are the strongest teaching signal', () => {
    expect(inferAnswerShape('give me a detailed, in-depth guide on negotiating a raise')).toBe('teaching');
    expect(inferAnswerShape('compare rust and go')).toBe('teaching');
  });

  it('long asks deserve depth (the >360-char rule)', () => {
    const longAsk = `i have a situation at work where ${'the context keeps growing and '.repeat(12)}what should i do`;
    expect(longAsk.length).toBeGreaterThan(360);
    expect(inferAnswerShape(longAsk)).toBe('teaching');
  });
});

describe('inferAnswerShape — focused and uncertain', () => {
  it('conceptual interrogatives are focused', () => {
    expect(inferAnswerShape('how does compound interest work')).toBe('focused');
    expect(inferAnswerShape('why does my bread dough not rise')).toBe('focused');
    expect(inferAnswerShape('why is the sky orange at sunset')).toBe('focused');
    expect(inferAnswerShape('tell me about the roman empire')).toBe('focused');
    expect(inferAnswerShape('is it worth learning to code in 2026')).toBe('focused');
  });

  it('signal-free non-interrogative text is uncertain (never lecture on a guess)', () => {
    expect(inferAnswerShape('the weather here has been really nice lately')).toBe('uncertain');
  });

  it('is deterministic for identical inputs (the KV re-render contract)', () => {
    const text = 'thanks, can you make that into a checklist';
    expect(inferAnswerShape(text, inThread)).toBe(inferAnswerShape(text, inThread));
    expect(inferAnswerShape(text)).toBe(inferAnswerShape(text));
  });
});

describe('hasExplicitFormatInstruction (hint-suppression detector)', () => {
  it('detects the instruction phrasings that must silence the hint', () => {
    for (const text of [
      'Answer in exactly one sentence: why is the sky blue?',
      'explain photosynthesis in 2 sentences',
      'give me tips on negotiating, keep it short',
      'summarize this in 3 bullet points',
      'describe the water cycle as a haiku',
      'respond in json format',
      'list the steps, no more than five lines',
      'Reply with just the number.',
    ]) {
      expect(hasExplicitFormatInstruction(text), text).toBe(true);
    }
  });

  it('stays quiet on ordinary asks (hints still apply)', () => {
    for (const text of [
      'please teach me how to invest',
      'how do i get better at cooking',
      'tell me about the roman empire',
      'i want to learn spanish but dont know where to start',
      'why does my bread dough not rise',
    ]) {
      expect(hasExplicitFormatInstruction(text), text).toBe(false);
    }
  });

  it('does NOT fire on instruction-shaped words used conversationally (review finding, PR #154)', () => {
    for (const text of [
      'respond with empathy please',
      'can you reply with the answer',
      'use only natural ingredients in the recipe',
      "what's a good way to briefly meet new people",
    ]) {
      expect(hasExplicitFormatInstruction(text), text).toBe(false);
    }
    // …while positioned brevity adverbs still count as instructions.
    expect(hasExplicitFormatInstruction('briefly, what is a vpn')).toBe(true);
    expect(hasExplicitFormatInstruction('explain photosynthesis, briefly')).toBe(true);
    expect(hasExplicitFormatInstruction('describe the krebs cycle briefly')).toBe(true);
  });
});
