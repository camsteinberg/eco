// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Chat template adapter — system-role normalization per model.
 *
 * Some chat templates (Jinja2 rendered by Transformers.js) throw when
 * they encounter `role: "system"`. Others support it natively. This
 * module rewrites the message array *before* `apply_chat_template` so
 * every model receives messages in a format its template can handle.
 *
 * The per-model strategy is stored in `catalog-data.json` as
 * `systemRoleSupport` and looked up by the adapter / worker at
 * generation time.
 *
 * Strategies:
 *   - "native"            — pass through; template supports `<|system|>` / ChatML system
 *   - "prepend-user"      — convert system message(s) to a user message at the front
 *   - "merge-first-user"  — prepend system content into the first user message
 */

// ─── Types ────────────────────────────────────────────────────────────────

export type SystemRoleSupport = 'native' | 'prepend-user' | 'merge-first-user';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Normalize a chat message array for a model whose template may not
 * support `role: "system"`.
 *
 * - "native"            — pass through unchanged; template supports system role
 * - "prepend-user"      — convert system message(s) to a separate user message
 *                         at the front of the array
 * - "merge-first-user"  — concatenate system content into the first user
 *                         message's content. Falls back to "prepend-user"
 *                         when no user message follows the system message(s).
 *
 * Edge cases:
 * - No system messages in `messages` → return unchanged regardless of strategy.
 * - Multiple system messages → concatenated with `\n\n` before applying strategy.
 * - "merge-first-user" with no user message after system → falls back to
 *   "prepend-user" so system content is never silently dropped.
 * - Non-system message ordering is always preserved.
 */
export function normalizeMessagesForTemplate(
  messages: ChatMessage[],
  strategy: SystemRoleSupport,
): ChatMessage[] {
  if (strategy === 'native') {
    return messages;
  }

  const systemMessages = messages.filter((m) => m.role === 'system');
  if (systemMessages.length === 0) {
    return messages;
  }

  const systemContent = systemMessages.map((m) => m.content).join('\n\n');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  if (strategy === 'prepend-user') {
    return [
      { role: 'user' as const, content: systemContent },
      ...nonSystem,
    ];
  }

  // strategy === 'merge-first-user'
  const firstUserIdx = nonSystem.findIndex((m) => m.role === 'user');
  if (firstUserIdx === -1) {
    // No user message to merge into — fall back to prepend-user
    return [
      { role: 'user' as const, content: systemContent },
      ...nonSystem,
    ];
  }

  const merged: ChatMessage[] = [...nonSystem];
  merged[firstUserIdx] = {
    role: 'user' as const,
    content: `${systemContent}\n\n${nonSystem[firstUserIdx]!.content}`,
  };
  return merged;
}
