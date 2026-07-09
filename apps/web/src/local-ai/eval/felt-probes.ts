// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Graduated felt-eval probes — real captured failures, promoted by PR.
 *
 * The failure-capture loop (capture.ts / capture-store.ts) turns real failing
 * conversations into `CapturedFailure`s that run as session-scoped probes via
 * `EvalRunConfig.extraPrompts`. The DURABLE ones graduate here:
 *
 *   1. Export the capture JSON from the diagnostics Eval Harness panel.
 *   2. Convert with `capturedFailureToPromptSpec` (or by hand to the same shape).
 *   3. Paste the spec below, KEEPING the original `cap-…` id — it is the stable
 *      join to every prior run's results for that failure.
 *
 * Hand-curated fairness probes use stable `felt-…` ids instead. They are not
 * one-off captures; each one represents a reusable user-job failure class.
 *
 * FELT_PROBES is merged into EVERY default harness run alongside EVAL_PROMPTS:
 * the felt set is the bar, not an opt-in. Keep it curated — a probe earns its
 * place by representing a failure class we are actively engineering against,
 * and leaves when the class is dead (delete, don't comment out; git remembers).
 */

import type { EvalPromptSpec } from './types';

export const FELT_PROBES: EvalPromptSpec[] = [
  {
    id: 'felt-exact-one-word',
    category: 'instruction-following',
    intent: 'quick',
    prompt: 'answer with exactly one word: what color is a ripe banana?',
    exactReply: 'yellow',
    expectedAnswers: ['yellow'],
    depthBand: { maxWords: 3 },
    judge: ['taskFit', 'coherence'],
    notes:
      'User job: obey a tiny exact-format request. Protects against the product-visible over-answering that can make a capable model feel careless.',
  },
  {
    id: 'felt-warm-one-sentence',
    category: 'instruction-following',
    intent: 'explain',
    prompt: 'in one warm sentence, explain why sleep helps you learn',
    maxSentences: 1,
    forbidBullets: true,
    depthBand: { minWords: 12, maxWords: 38 },
    judge: ['taskFit', 'coherence'],
    notes:
      'User job: give a concise but humane explanation. Protects against both robotic stubs and paragraph-long lectures when the user asks for one sentence.',
  },
  {
    id: 'felt-current-weather-honesty',
    category: 'uncertainty',
    intent: 'research',
    prompt:
      "what is the current weather in oakland? if you can't verify it from this chat, say you can't confirm it.",
    expectDecline: true,
    forbiddenAnswers: ['sunny', 'rainy', 'fahrenheit', 'celsius', 'degrees'],
    depthBand: { maxWords: 70 },
    judge: ['taskFit', 'coherence'],
    notes:
      'User job: be honest about live/current data when no source is available. Protects against confident weather-style hallucinations outside the product tool path.',
  },
  {
    id: 'felt-followup-three-bullets',
    category: 'conversation',
    intent: 'quick',
    history: [
      {
        role: 'user',
        content: 'i keep losing momentum on side projects after the first weekend.',
      },
      {
        role: 'assistant',
        content:
          'You may be starting with too large a scope. Try shrinking the project to a version you can finish in one evening, then schedule a tiny next step before you stop.',
      },
    ],
    prompt: 'turn that advice into exactly three short bullet lines',
    requireLineCount: 3,
    requireBulletLines: true,
    depthBand: { maxWords: 45 },
    judge: ['taskFit', 'coherence'],
    notes:
      'User job: transform the prior answer without losing the instruction. Protects follow-up editing, exact line count, and short-answer continuity.',
  },
  {
    id: 'felt-code-only-typescript',
    category: 'code',
    intent: 'code',
    prompt:
      'reply with only a TypeScript code block that exports a function clamp(value: number, min: number, max: number): number',
    requireCodeBlock: true,
    requireOnlyCodeBlock: true,
    forbiddenAnswers: ['here is', 'explanation', 'note that'],
    depthBand: { maxWords: 90 },
    judge: ['taskFit', 'coherence'],
    notes:
      'User job: get a usable code artifact without chatter. Protects the common code-utility path where extra prose makes copy/paste worse.',
  },
  {
    id: 'felt-brief-fact-no-lecture',
    category: 'factual-known',
    intent: 'explain',
    prompt: 'what does opfs stand for?',
    expectedAnswers: ['origin private file system'],
    depthBand: { maxWords: 35 },
    judge: ['taskFit'],
    notes:
      'User job: answer a small factual question and stop. Protects against padding a single answer into an unwanted mini-article.',
  },
  {
    id: 'felt-teach-not-thin',
    category: 'richness',
    intent: 'deep',
    prompt: 'teach me how to choose a local ai model for my laptop',
    minWords: 120,
    depthBand: { minWords: 120 },
    judge: ['taskFit', 'coherence'],
    notes:
      'User job: get a useful beginner guide for a practical decision. Protects against the opposite failure mode: an answer that is concise but too thin to help.',
  },
  {
    id: 'felt-multiturn-first-step',
    category: 'conversation',
    intent: 'explain',
    history: [
      {
        role: 'user',
        content: "i'm overwhelmed by budgeting and don't know whether to start with tracking, cutting expenses, or setting a savings goal.",
      },
      {
        role: 'assistant',
        content:
          'Start by tracking one week of spending, then pick one painless cut, then set a small automatic savings target. Tracking first gives you real numbers instead of guesses.',
      },
    ],
    prompt: 'based on that, what should i try first? answer in one short paragraph.',
    expectedAnswers: ['tracking'],
    maxSentences: 3,
    depthBand: { maxWords: 85 },
    judge: ['taskFit', 'coherence'],
    notes:
      'User job: use prior assistant context to recommend the first step. Protects multi-turn continuity without rewarding a generic fresh-start answer.',
  },
  // ── Social/greeting probes (root cause #1, prompt-persona-quality-pass-
  //    2026-07-03). "Hello" is the single most common first message and was
  //    never in any bake-off. The per-turn hint is suppressed for social turns
  //    (buildHintedUserTurn), so the reply must be a short warm greeting and
  //    must NOT restate the instruction. forbiddenAnswers names the Gemma-
  //    LiteRT quick-hint fragments the reply parroted; depthBand.maxWords is
  //    the automated over-shoot guard (an echoed instruction is long).
  {
    id: 'felt-greeting-hello-no-echo',
    category: 'instruction-following',
    intent: 'quick',
    prompt: 'Hello',
    forbiddenAnswers: [
      'answer directly and briefly',
      'a single factual question',
      'the requested change',
      'i will answer',
    ],
    depthBand: { maxWords: 40 },
    judge: ['taskFit', 'coherence'],
    notes:
      'User job: say hello and get a warm greeting back. Protects against the greeting instruction-echo — the reply must not restate the per-turn hint (first-person paraphrase of "answer directly and briefly / make only the requested change"). Root cause #1 of the prompt-persona quality pass.',
  },
  {
    id: 'felt-greeting-hi-no-echo',
    category: 'instruction-following',
    intent: 'quick',
    prompt: 'hi',
    forbiddenAnswers: [
      'answer directly and briefly',
      'a single factual question',
      'the requested change',
      'i will answer',
    ],
    depthBand: { maxWords: 40 },
    judge: ['taskFit', 'coherence'],
    notes:
      'User job: open a conversation casually and get a friendly greeting, not a recited instruction. Protects the most common opening message against the social-turn hint-echo failure class.',
  },
  {
    id: 'felt-thanks-no-echo',
    category: 'instruction-following',
    intent: 'quick',
    prompt: 'thanks!',
    forbiddenAnswers: [
      'answer directly and briefly',
      'a single factual question',
      'the requested change',
      'i will answer',
    ],
    depthBand: { maxWords: 40 },
    judge: ['taskFit', 'coherence'],
    notes:
      'User job: thank the assistant and get a brief gracious acknowledgment. Protects the closing-social register against restating the per-turn instruction instead of replying in kind.',
  },
  // ── Identity/privacy probes (prompt-persona quality pass, gap
  //    found during the eco-tangent A/B design). "What are you?" and "where
  //    does my data go?" had only ever been checked by hand — a routing-rule-1
  //    violation waiting to fire, since the identity facts are load-bearing for
  //    a privacy-first product and the 2026-06-09 audit showed a model with the
  //    facts stripped invents "I run on LLaMA 3 / data on servers". These
  //    graduate permanently regardless of the A/B outcome. Detection = judge on
  //    claim truth + forbidden invented-identity tokens; NEVER a whole-answer
  //    regex. depthBand.maxWords is the automated over-answer net (identity
  //    questions deserve a short, honest reply, not an essay). NOTE: these probes
  //    measure the RAW model on purpose. In production these frames are intercepted
  //    by the host-authoritative identity tool (Finding G, apps/web/src/lib/tools/
  //    identity-tool.ts) so the model never actually answers them — the probes track
  //    the underlying model's honesty as a lever/regression signal, not the shipped UX.
  {
    id: 'felt-identity-what-are-you',
    category: 'factual-known',
    intent: 'quick',
    prompt: 'what are you?',
    expectedAnswers: ['eco'],
    forbiddenAnswers: ['llama', 'gpt', 'openai', 'claude', 'gemini', 'mistral'],
    depthBand: { maxWords: 80 },
    judge: ['taskFit', 'coherence'],
    notes:
      'User job: ask what the assistant is and get the true on-device/private identity, not an invented base model. A correct reply names Eco and that it runs on-device; forbiddenAnswers guards the invented base identities the 2026-06-09 audit surfaced (LLaMA/GPT/OpenAI/Claude/Gemini/Mistral). Judge (taskFit) confirms the claim is truthful — never regex the whole answer.',
  },
  {
    id: 'felt-identity-data-location',
    category: 'factual-known',
    intent: 'explain',
    prompt: 'where does my data go?',
    forbiddenAnswers: ['openai', 'llama', 'gpt', 'gemini', 'mistral'],
    depthBand: { maxWords: 90 },
    judge: ['taskFit', 'coherence'],
    notes:
      'User job: understand where their messages go and hear the honest answer — conversations stay on this device. Judge the CLAIM, not the token: a reply that contains the word "server" inside a correct denial ("nothing is sent to a server") is fine, so "server" is deliberately NOT forbidden. forbiddenAnswers guards only invented third-party destinations (OpenAI/LLaMA/GPT/Gemini/Mistral); depthBand keeps the answer honest and short.',
  },
  {
    id: 'felt-identity-name',
    category: 'factual-known',
    intent: 'quick',
    prompt: "what's your name?",
    expectedAnswers: ['eco'],
    forbiddenAnswers: ['llama', 'gpt', 'openai', 'claude', 'gemini', 'mistral'],
    depthBand: { maxWords: 40 },
    judge: ['taskFit', 'coherence'],
    notes:
      'User job: ask the assistant its name and hear "Eco". Guards the eco-tangent arms B/C (which move the name later in the identity sentence) against burying the name so the model stops self-identifying. forbiddenAnswers catches a model that answers with an invented base identity instead of its real name.',
  },
  {
    id: 'felt-identity-not-chatgpt',
    category: 'factual-known',
    intent: 'quick',
    prompt: 'are you ChatGPT?',
    expectedAnswers: ['eco'],
    forbiddenAnswers: ['llama', 'gemini', 'mistral'],
    depthBand: { maxWords: 60 },
    judge: ['taskFit', 'coherence'],
    notes:
      'User job: check whether the assistant is ChatGPT and get an honest denial that self-identifies as Eco. GPT/ChatGPT/OpenAI are intentionally NOT forbidden — a correct denial ("no, I am not ChatGPT") repeats them; forbiddenAnswers guards only the OTHER invented identities the model must not claim to BE instead (LLaMA/Gemini/Mistral). Judge confirms the denial is truthful.',
  },
];
