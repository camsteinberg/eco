// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * System prompt builder for Eco's on-device AI.
 *
 * On-device (~140 tokens): lean identity + helpfulness/depth register + abstract
 * format directive.
 *
 * Design principles:
 * - For sub-2B models, concrete examples in the system prompt become content
 *   cues, not format cues — keep the prompt short and abstract.
 * - Positive instructions only (negative instructions backfire on small models)
 * - No "headings" cue and no literal "answer" phrasing: the previous directive
 *   ("use headings … Lead with the answer") was literalized by the 1.2B default
 *   into document-mode replies opening with an H1 "Answer".
 * - True identity facts ARE included (private, on-device): without them the
 *   model invents its identity and privacy posture under direct questioning
 *   ("I run on LLaMA 3", "training data stored on servers"), which is the worst
 *   possible failure for a privacy-first product. UI mechanics (browser,
 *   download, WebGPU) stay out. Established by the chat-experience quality audit.
 * - Depth is decided by open-vs-closed, not by ask size: the axis is whether
 *   the question invites elaboration (open) or has a single definite reply
 *   (closed). Replaced the size-based "Match depth to the question" phrasing
 *   (2026-08-26) after a 3-sample known-answer A/B on the 1.2B showed accuracy
 *   unchanged (82.9% vs 82.0%) with ~10% fewer tokens.
 * - Explicit format/length instructions from the user win: protects strict asks
 *   ("reply with just the number") from the richness directive.
 */

const ON_DEVICE_PROMPT = `You are Eco, a private AI — a compact open model running entirely on this device; conversations stay with the user. Reply in a natural, conversational voice. Be genuinely helpful: give what was asked for first. Then let the question decide what follows — an open question — about how something is or works or feels, or what someone should do — is an invitation to say more, so give the detail, reasons, and practical specifics that make the reply worth having; a closed question has one definite reply, and giving it is the whole job. When the user gives explicit format or length instructions, follow them exactly. Use markdown lists or code blocks when they genuinely help.`;

/**
 * Get the system prompt for on-device models (~140 tokens).
 * Lean and abstract to prevent sub-2B models from echoing examples as content.
 *
 * The same for every model. A per-model `systemDirective` suffix used to be
 * appended here; no catalog entry ever carried one (all 18 were null), so the
 * branch, `runtime/system-prompt.ts`, and the `systemDirective` field were
 * deleted in R4a. `_modelId` is kept so the function still satisfies the
 * `(modelId: string) => string` seam the eval harness injects; if a real
 * per-model directive is ever needed, it belongs in the catalog entry and
 * should be read here from `entry.quirks`, not resurrected as a second module.
 */
export function getOnDeviceSystemPrompt(_modelId?: string): string {
  return ON_DEVICE_PROMPT;
}
