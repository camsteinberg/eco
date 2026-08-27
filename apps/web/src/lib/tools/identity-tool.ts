// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Host-authoritative identity / privacy tool (Finding G, launch-bar 2026-07-03).
 *
 * A privacy-first product cannot let a sub-2B model narrate its own privacy
 * posture: the 350m starter fabricates FALSE cloud-privacy claims ("your data
 * goes to Amazon S3 / Google Cloud") in ~1/3 samples on "where does my data go?"
 * and invents base identities ("I'm ChatGPT / LLaMA"). That inverts the core
 * promise and violates the CLAUDE.md privacy-accuracy constraint. So the HOST
 * detects identity / privacy / "are you <product>?" turns and states the on-device
 * truth VERBATIM — the model never generates. This is the third instance of the
 * established host-authoritative pattern (calculator/datetime/unit canonical
 * answers; see the engineering-review Corollary).
 *
 * Detection is deliberately narrow and WHOLE-TURN anchored (never a keyword scan):
 * the entire normalized turn must match one anchored alternation, so "where does
 * Dropbox store my data?", "how does Google Cloud work?", and "tell me about
 * ChatGPT" all abstain and route to normal chat / grounding. A miss is safe (the
 * model answers normally); a false positive would replace a real answer with the
 * identity boilerplate, so the matcher abstains on any ambiguity — the same
 * over-call discipline every tool in this registry follows.
 *
 * The answers are hand-authored to satisfy the privacy-accuracy constraint:
 * conversations DO persist locally (OPFS / browser storage), so we say so plainly
 * rather than overclaiming "nothing is stored". The tool is `presentation:
 * "host-answer"`: no ToolCallBlock, and — unlike the citation tools — it is NOT
 * gated by the web-lookups setting (that gate only removes `presentation:
 * "citation"` tools), so the on-device truth is stated whether lookups are on or off.
 */

import type { EcoTool, EcoToolResult } from "./registry";

/**
 * The recognized identity / privacy frame for a turn.
 *  - `"identity"`      — "what/who are you", "what's your name", "who made you", …
 *  - `"data-location"` — "where does my data go", "is this private", …
 *  - `"are-you-x"`     — "are you ChatGPT / Claude / Gemini / …" (carries `subject`).
 */
export type IdentityArgs = {
  intent: "identity" | "data-location" | "are-you-x";
  /** The named AI product for the `"are-you-x"` intent, in canonical display casing. */
  subject?: string;
};

/**
 * The on-device truth for "what/who are you" and name/maker questions. Honest about
 * local persistence: conversations are saved in this browser's storage (so the
 * accuracy constraint holds — we never claim "nothing is stored").
 */
export const IDENTITY_HOST_ANSWER =
  "I'm Eco — a private AI that runs entirely on this device. The model answering you " +
  "lives in your browser, so your messages aren't sent to a server to generate replies. " +
  "Your conversations are saved locally in this browser's storage so you can pick them " +
  "back up later, and you can delete them anytime.";

/**
 * The on-device truth for "where does my data go" and privacy questions. Includes
 * the one honest exception (opt-in web lookups send only the looked-up term, never
 * the conversation) so the answer is accurate rather than absolute.
 */
export const DATA_LOCATION_HOST_ANSWER =
  "Your messages stay on this device. Eco's model runs right here in your browser — " +
  "nothing you type is sent to a cloud service to generate a reply. Your conversation " +
  "history is stored locally in this browser's storage (that's how it's here when you " +
  "come back), and you can clear it whenever you like. One honest note: if you turn on " +
  "web lookups, the search terms from your question are sent to that source — but " +
  "never your conversation.";

/** The on-device truth for "are you <product>?" — an honest denial that self-identifies. */
export function areYouXHostAnswer(subject: string): string {
  return `No — I'm not ${subject}. I'm Eco, a private AI running entirely on this ` +
    "device. The model answering you runs locally in your browser, and your " +
    "conversations stay here, saved in local browser storage that you can clear anytime.";
}

function isIdentityArgs(value: unknown): value is IdentityArgs {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as { intent?: unknown; subject?: unknown };
  if (
    v.intent !== "identity" &&
    v.intent !== "data-location" &&
    v.intent !== "are-you-x"
  ) {
    return false;
  }
  return v.subject === undefined || typeof v.subject === "string";
}

/**
 * Normalize a turn for whole-turn matching: lowercase, straighten curly
 * apostrophes, trim, strip trailing `?!.`, and peel a leading run of conversational
 * fillers ("hey", "so", "ok", "btw"). What remains must match an anchored pattern
 * IN FULL — so any trailing clause ("who are you voting for") fails the `$` anchor
 * and abstains.
 */
function normalize(raw: string): string {
  let s = raw.toLowerCase().replace(/[’‘]/g, "'").trim();
  // Strip a leading run of fillers, each followed by a comma/whitespace separator.
  s = s.replace(/^(?:(?:hey|so|ok|okay|btw|um|well)\b[,\s]+)+/, "");
  // Strip trailing sentence punctuation / whitespace.
  s = s.replace(/[?!.\s]+$/, "");
  return s.trim();
}

/** Whole-turn identity frames ("what/who are you", name, maker). */
const IDENTITY_PATTERNS: readonly RegExp[] = [
  /^what are you$/,
  /^who are you(?:,?\s*really)?$/,
  /^what(?:'?s| is) your name$/,
  /^what model are you$/,
  /^what (?:ai|llm)(?: model)? is this$/,
  /^what model is this$/,
  /^who (?:made|created) you$/,
];

/** Whole-turn data-location / privacy frames. */
const DATA_LOCATION_PATTERNS: readonly RegExp[] = [
  /^where does my data go$/,
  /^where (?:is|are) my (?:data|conversations?|chats?|messages?) (?:stored|saved|kept)$/,
  /^is my data (?:sent|uploaded) to the cloud$/,
  /^do you (?:send|upload|share) my data(?: (?:anywhere|with anyone))?$/,
  /^is this (?:private|confidential)$/,
  /^are my (?:conversations?|chats?|messages?) private$/,
  /^who can see my (?:messages?|chats?|conversations?|data)$/,
  /^does my data leave (?:this device|my device|my computer)$/,
  /^is my data stored in the cloud$/,
];

/**
 * "are you <product>?" — the subject alternation. Order matters: the more specific
 * `chatgpt` and `gpt-?\d+` forms precede the bare `gpt` so they win.
 */
const ARE_YOU_X_RE =
  /^are you (chatgpt|gpt-?\d+|gpt|openai|claude|anthropic|gemini|bard|llama|mistral|copilot)$/;

/** Known AI products in canonical display casing (for the `are-you-x` subject). */
const AI_SUBJECT_DISPLAY: Record<string, string> = {
  chatgpt: "ChatGPT",
  gpt: "GPT",
  openai: "OpenAI",
  claude: "Claude",
  anthropic: "Anthropic",
  gemini: "Gemini",
  bard: "Bard",
  llama: "Llama",
  mistral: "Mistral",
  copilot: "Copilot",
};

/** Map a matched (lowercase) subject to display casing, e.g. "chatgpt" → "ChatGPT". */
function canonicalizeSubject(matched: string): string {
  const known = AI_SUBJECT_DISPLAY[matched];
  if (known !== undefined) {
    return known;
  }
  // gpt-4 / gpt4 → "GPT-4" (only the versioned GPT forms reach here).
  const gpt = /^gpt-?(\d+)$/.exec(matched);
  if (gpt?.[1] !== undefined) {
    return `GPT-${gpt[1]}`;
  }
  return matched;
}

function matchIdentity(userText: string): IdentityArgs | null {
  if (typeof userText !== "string" || userText.trim() === "") {
    return null;
  }
  const text = normalize(userText);
  if (text === "") {
    return null;
  }

  const areYouX = ARE_YOU_X_RE.exec(text);
  if (areYouX?.[1] !== undefined) {
    return { intent: "are-you-x", subject: canonicalizeSubject(areYouX[1]) };
  }

  for (const pattern of DATA_LOCATION_PATTERNS) {
    if (pattern.test(text)) {
      return { intent: "data-location" };
    }
  }

  for (const pattern of IDENTITY_PATTERNS) {
    if (pattern.test(text)) {
      return { intent: "identity" };
    }
  }

  return null;
}

function executeIdentity(args: IdentityArgs): EcoToolResult {
  const display =
    args.intent === "data-location"
      ? DATA_LOCATION_HOST_ANSWER
      : args.intent === "are-you-x"
        ? areYouXHostAnswer(args.subject ?? "that")
        : IDENTITY_HOST_ANSWER;

  // `forModel` is empty and unused: the host shows `display` verbatim and the model
  // never runs (presentation:"host-answer"). Pure/synchronous — no network, no I/O.
  return { display, forModel: "", ok: true };
}

export const identityTool: EcoTool<IdentityArgs> = {
  name: "identity",
  description:
    "State Eco's on-device identity and privacy truth verbatim for who/what-are-you, " +
    "where-does-my-data-go, and are-you-<product> questions (the model never answers these).",
  validate: isIdentityArgs,
  match: matchIdentity,
  execute: executeIdentity,
  presentation: "host-answer",
};
