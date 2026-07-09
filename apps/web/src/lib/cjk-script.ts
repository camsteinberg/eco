// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Shared CJK-script detection.
 *
 * Single source of truth for "does this text contain CJK script?" — used by
 * BOTH the eval rubric's `noCjkLeak` dimension (local-ai/eval/rubric.ts) and
 * the runtime's deterministic CJK-token suppression gate
 * (local-ai/runtime/cjk-suppression.ts). The two MUST agree on what counts as
 * CJK or the instrument measures a different thing than the fix suppresses.
 *
 * Lives in lib/ (not eval/ or runtime/) because eval and runtime must not
 * import from each other.
 */

/**
 * Matches CJK *script* characters: CJK Unified Ideographs (U+4E00–U+9FFF),
 * Hiragana (U+3040–U+309F), Katakana (U+30A0–U+30FF), and Hangul Syllables
 * (U+AC00–U+D7AF). DELIBERATELY excludes CJK Symbols & Punctuation
 * (U+3000–U+303F) and Fullwidth Forms — a stray fullwidth comma is not the leak
 * class we guard. Also deliberately NOT covered: Extension A (U+3400–U+4DBF)
 * and Compatibility Ideographs (U+F900–U+FAFF) — rare blocks outside the
 * measured leak class, scoped out since the rubric's first version; widen here
 * (one source for rubric + runtime) if a leak from those blocks is ever
 * measured. Emoji and Latin accents are outside every range, so they never
 * match.
 */
export const CJK_SCRIPT_RE = /[一-鿿぀-ゟ゠-ヿ가-힯]/;

/**
 * Whether `text` contains any CJK script character (see `CJK_SCRIPT_RE`).
 */
export function hasCjkScript(text: string): boolean {
  return CJK_SCRIPT_RE.test(text);
}
