// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { getModel } from "../local-ai/catalog/catalog";
import { getLocalModelSystemPromptSuffix } from "../local-ai/runtime/system-prompt";
import { isLocalAiModel } from "../local-ai/util";

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
 * - Depth is matched to the question, not minimized: the previous "as short as
 *   the question allows" directive (#132) overcorrected — the instruction-tuned
 *   default followed it into unhelpfully terse replies (chat #7). The richness
 *   directive stays abstract (no examples) and is balanced by the depth-matching
 *   clause so simple asks stay brief.
 * - Explicit format/length instructions from the user win: protects strict asks
 *   ("reply with just the number") from the richness directive.
 */

const ON_DEVICE_PROMPT = `You are Eco, a private AI — a compact open model running entirely on this device; conversations stay with the user. Reply in a natural, conversational voice. Be genuinely helpful: address what was asked, then add the context, reasons, or practical details that make the reply useful on its own. Match depth to the question — a simple ask gets a brief reply; an open or substantial one deserves a thorough, well-developed reply. When the user gives explicit format or length instructions, follow them exactly. Use markdown lists or code blocks when they genuinely help.`;

/**
 * Get the system prompt for on-device models (~140 tokens).
 * Lean and abstract to prevent sub-2B models from echoing examples as content.
 */
export function getOnDeviceSystemPrompt(modelId?: string): string {
  if (!modelId || !isLocalAiModel(modelId)) return ON_DEVICE_PROMPT;
  // Try the v1 catalog first; if the model isn't in the catalog, skip the suffix.
  const catalogModel = getModel(modelId);
  const suffix = catalogModel ? getLocalModelSystemPromptSuffix(modelId) : null;
  return suffix ? `${ON_DEVICE_PROMPT}\n${suffix}` : ON_DEVICE_PROMPT;
}
