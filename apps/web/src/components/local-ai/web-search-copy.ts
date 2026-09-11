// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The words for the Web search switch, in one place.
 *
 * Every privacy claim Eco makes about web search has to say the same thing in
 * Settings, on the privacy page, on the transparency page and in the README, so
 * the sentences that appear in more than one surface live here rather than being
 * retyped. The claim is deliberately bounded and no stronger:
 *
 * - what leaves: the search terms of a question about right now, and only while
 *   the switch is on;
 * - the path: Eco's relay → Eco's own search instance → the public engines,
 *   which see Eco's server's address, never the person's;
 * - what is kept: a successful search is not logged and is not linked to any
 *   account. NOT "keeps no record" — a failed engine call can still leave a
 *   short-lived server log line (carrying no account), so the privacy page says
 *   that plainly and nothing here contradicts it;
 * - what never leaves: the conversation itself;
 * - the marker: every searched reply carries a chip with the fetched-at time,
 *   so a person can always tell which turns went out.
 *
 * This is a separate path from the older Wikipedia/Wikidata "web lookups"
 * feature, which still goes direct from the browser to Wikimedia and never
 * touches Eco's servers. Keep the two descriptions distinct.
 */

/** Settings → Eco, the row under "Search the web for live questions". */
export const WEB_SEARCH_SETTING_DESCRIPTION =
  "When on, Eco searches the web for questions about right now, automatically, "
  + "before it answers. Only the search terms from that question go to Eco's relay; "
  + "they are not logged on success or linked to your account, and the engines never "
  + "see you. Every searched reply shows a chip with the time.";

/** The composer switch's tooltip — the same claim, at hover length. */
export const WEB_SEARCH_TOGGLE_TOOLTIP =
  "When on, Eco searches the web for questions about right now. Only the search "
  + "terms go to Eco's relay.";

/** "Private by design" (Settings → Eco), appended after the Wikipedia clause. */
export const WEB_SEARCH_PRIVATE_BY_DESIGN_CLAUSE =
  "With Web search on, questions about right now send only their search terms to "
  + "Eco's relay, which does not log successful searches or link them to you; the "
  + "search engines see Eco's server, never you.";
