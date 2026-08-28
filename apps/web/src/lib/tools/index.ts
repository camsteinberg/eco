// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Host-driven deterministic tool registry — public surface (#4 Phase 4a).
 *
 * The pipeline (Task 2) imports {@link detectTool} + {@link DEFAULT_TOOLS} to run
 * detection over the latest user turn, then executes the matched tool.
 */

import { calculatorTool } from "./calculator-tool";
import { datetimeTool } from "./datetime-tool";
import { identityTool } from "./identity-tool";
import { moneyTool } from "./money-tool";
import {
  detectTool as detectToolFromRegistry,
  type AnyEcoTool,
  type EcoToolDetection,
  type EcoToolRegistry,
  type ToolMatchContext,
} from "./registry";
import { unitTool } from "./unit-tool";
import { wikipediaGroundingTool } from "./wikipedia-grounding-tool";

export type {
  AnyEcoTool,
  EcoCitation,
  EcoTool,
  EcoToolDetection,
  EcoToolRegistry,
  EcoToolResult,
  GroundingVerification,
  ToolMatchContext,
} from "./registry";
export type { CalculatorArgs } from "./calculator-tool";
export type { DatetimeArgs } from "./datetime-tool";
export type { IdentityArgs } from "./identity-tool";
export type { MoneyArgs } from "./money-tool";
export type { UnitArgs } from "./unit-tool";
export type { GroundingArgs } from "./wikipedia-grounding-tool";
export { calculatorTool } from "./calculator-tool";
export { datetimeTool } from "./datetime-tool";
export {
  identityTool,
  IDENTITY_HOST_ANSWER,
  DATA_LOCATION_HOST_ANSWER,
  areYouXHostAnswer,
} from "./identity-tool";
export { moneyTool } from "./money-tool";
export { unitTool } from "./unit-tool";
export { wikipediaGroundingTool } from "./wikipedia-grounding-tool";

/**
 * The shipping tools in priority order. `detectTool` returns the first whose
 * `match` is confident, so order matters: `identityTool` sweeps FIRST (identity /
 * privacy / "are you <product>?" frames — Finding G), because those frames must win
 * before grounding's fuzzy entity extractor can steal e.g. "ChatGPT" out of "are
 * you ChatGPT?" and turn a privacy question into a Wikipedia lookup. Its matcher is
 * whole-turn anchored and abstains on anything that is not squarely an identity /
 * privacy question, so putting it first cannot pre-empt a genuine arithmetic /
 * factual turn. Then the deterministic tools (calculator → datetime → unit-
 * conversion → money) win their frames. `moneyTool` sits at the end of that group:
 * it must pre-empt the fuzzy grounding sweep on turns like "24% APR — what does
 * that mean for me?", but it must never take a plain percentage calculation from
 * the calculator or a clock question from datetime, so it runs after both.
 * Finally `wikipediaGroundingTool` sweeps LAST
 * (its matcher is the broadest/fuzziest, so it must not pre-empt a more specific
 * frame a preceding tool answers).
 *
 * `identityTool` is `presentation:"host-answer"` (Finding G): the host states Eco's
 * on-device truth verbatim and the model never generates — the second instance of
 * the host-authoritative pattern (calculator/datetime/unit canonical answers).
 * Because it is NOT `presentation:"citation"`, the web-
 * lookups gate never removes it, so the identity/privacy truth is stated whether
 * lookups are on or off. Grounding is the network-backed CITATION tool: its
 * `execute` is ASYNC and its `presentation` is `"citation"` (no ToolCallBlock; the
 * model phrases & cites, or declines / asks to clarify honestly). The pipeline
 * (#5 S3) ties its lookup to the generation's AbortController so a user-stop
 * mid-lookup cancels it.
 */
export const DEFAULT_TOOLS: readonly AnyEcoTool[] = [
  identityTool,
  calculatorTool,
  datetimeTool,
  unitTool,
  moneyTool,
  wikipediaGroundingTool,
];

/** The default tools keyed by `name` (for lookup by id, e.g. from a tool event). */
export const DEFAULT_TOOL_REGISTRY: EcoToolRegistry = Object.freeze(
  Object.fromEntries(DEFAULT_TOOLS.map((tool) => [tool.name, tool]))
);

/**
 * Run host-side detection over `userText` against {@link DEFAULT_TOOLS}. Returns
 * the first confident match, or `null` to fall back to normal chat.
 *
 * `context` is OPTIONAL conversation-derived hints (see {@link ToolMatchContext}),
 * forwarded to each tool's `match`. Appended LAST so the one-arg form is unchanged.
 */
export function detectTool(
  userText: string,
  context?: ToolMatchContext,
): EcoToolDetection | null {
  return detectToolFromRegistry(userText, DEFAULT_TOOLS, context);
}

/**
 * Run host-side detection over `userText` against an EXPLICIT tool list. The
 * list form behind {@link detectTool}, re-exported for callers that gate the tool
 * set (e.g. the grounding on/off setting, #5 S5, which passes DEFAULT_TOOLS with
 * the citation tool removed). Returns the first confident match, or `null`.
 *
 * `context` is OPTIONAL conversation-derived hints (see {@link ToolMatchContext}),
 * forwarded to each tool's `match`. Appended LAST so existing two-arg callers are
 * unchanged.
 */
export function detectToolFrom(
  userText: string,
  tools: readonly AnyEcoTool[],
  context?: ToolMatchContext,
): EcoToolDetection | null {
  return detectToolFromRegistry(userText, tools, context);
}
