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
}
