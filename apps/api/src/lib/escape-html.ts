// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Escape a string for safe interpolation into HTML text or attribute contexts.
 *
 * Used for user-controlled values (e.g. `user.name`) that get inlined into the
 * transactional-email HTML. The emails are self-directed (delivered only to the
 * account's own address), so this is not a cross-user XSS vector — but an
 * unescaped name is sloppy in HTML, and escaping keeps the interpolation honest
 * regardless of where the string later renders (webmail previews, forwarded
 * copies, etc.).
 *
 * Escapes the five characters that are significant in HTML text/attribute
 * contexts: `&`, `<`, `>`, `"`, `'`. `&` is replaced first so the entities
 * introduced by the later replacements are not double-escaped.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
