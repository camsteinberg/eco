// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * A source attribution carried on an assistant message.
 *
 * `source`/`asOf` are set by the grounding path (#5 S3): `CitationBlock` styles the
 * chip from `source` ("Wikipedia"/"Wikidata") and `asOf` (the year a fact was
 * recorded, itself a trust signal). Both are optional.
 */
export type Citation = {
  id: number
  title: string
  url: string
  snippet?: string
  /** Which surface a grounded fact came from (e.g. "Wikipedia"). */
  source?: string
  /** The year a grounded fact was recorded (e.g. "2023"), when known. */
  asOf?: string
  /**
   * The grounding tool's confidence tier for this hit, mirrored from
   * {@link import("./tools/registry").EcoCitation.groundingConfidence} so it
   * survives persistence. Only `"high"` (clean entity + coverage-gate pass) earns
   * the once-per-chat "isn't guesswork" disclosure; the fuzzier tiers keep their
   * chip but suppress that claim. Absent on legacy rows / research citations —
   * treated as non-`"high"`.
   */
  groundingConfidence?: "high" | "low" | "followup" | "fulltext"
}
