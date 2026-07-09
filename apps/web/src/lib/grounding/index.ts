// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Wikimedia grounding lookup engine — public surface (#5 Slice 1).
 *
 * A later slice composes {@link lookupWikipedia} + {@link getWikidataStatement}
 * into a chat tool and a citation render. This slice ships only the data layer.
 */

export type {
  GroundingRequestOptions,
  WikidataStatement,
  WikipediaDeclineReason,
  WikipediaFulltextResult,
  WikipediaResult,
  WikipediaSearchPage,
} from "./types";
export {
  clearGroundingCache,
  DEFAULT_TIMEOUT_MS,
  getWikidataStatement,
  lookupWikipedia,
  searchWikipediaFulltext,
} from "./wikimedia";
