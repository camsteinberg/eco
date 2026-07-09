// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Unit tests for {@link deriveGroundedMatchContext} (chat #7 W2.2 T1; weather
 * follow-up T1).
 *
 * Pure scan over a chat message list — no store, no mocks. Verifies the recency
 * bound, the no-citation case, exclusion of the in-flight streaming reply, and the
 * locked recency-correct rule: the SINGLE most-recent grounded turn decides the
 * antecedent, whatever its source — so a more-recent weather turn is never skipped
 * to reach an older Wikipedia one. lastGroundedTitle and lastWeatherLocation are
 * mutually exclusive.
 */

import { describe, it, expect } from "vitest";
import {
  deriveGroundedMatchContext,
  GROUNDED_TITLE_LOOKBACK,
} from "../grounding-context";
import type { ChatMessage } from "../../../stores/chatStore";
import type { Citation } from "../../../lib/citation-parser";

let seq = 0;

/** Minimal ChatMessage factory — only the fields the scan reads matter. */
function msg(
  role: ChatMessage["role"],
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  seq += 1;
  return {
    id: overrides.id ?? `m${seq}`,
    role,
    content: overrides.content ?? "",
    createdAt: seq,
    ...overrides,
  };
}

/** A Wikipedia citation as the grounding path (#5 S3) writes it. */
function wikiCitation(title: string): Citation {
  return {
    id: 1,
    title,
    url: `https://en.wikipedia.org/wiki/${title.replace(/\s+/g, "_")}`,
    source: "Wikipedia",
  };
}

/** An Open-Meteo citation as the weather path (capability wave) writes it. */
function weatherCitation(location: string): Citation {
  return {
    id: 1,
    title: location,
    url: "https://open-meteo.com/",
    source: "Open-Meteo",
  };
}

function assistantGrounded(title: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return msg("assistant", { content: `About ${title}.`, citations: [wikiCitation(title)], ...overrides });
}

function assistantWeather(location: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return msg("assistant", {
    content: `Weather in ${location}.`,
    citations: [weatherCitation(location)],
    ...overrides,
  });
}

describe("deriveGroundedMatchContext", () => {
  it("returns lastGroundedTitle when the most-recent grounded turn is Wikipedia", () => {
    const messages = [
      msg("user", { content: "tell me about the Eiffel Tower" }),
      assistantGrounded("Eiffel Tower"),
      msg("user", { content: "how tall is it?" }),
    ];
    expect(deriveGroundedMatchContext(messages)).toEqual({ lastGroundedTitle: "Eiffel Tower" });
  });

  it("returns lastWeatherLocation when the most-recent grounded turn is Open-Meteo", () => {
    const messages = [
      msg("user", { content: "weather in London" }),
      assistantWeather("London"),
      msg("user", { content: "what about Paris?" }),
    ];
    expect(deriveGroundedMatchContext(messages)).toEqual({ lastWeatherLocation: "London" });
  });

  it("is recency-correct: a more-recent weather turn beats an older Wikipedia turn", () => {
    // THE regression lock. Old behavior scanned past the weather turn to the
    // Wikipedia one; the locked rule resolves against the single most-recent
    // grounded turn — here, the weather turn — and never sets both fields.
    const messages = [
      msg("user", { content: "tell me about the Eiffel Tower" }),
      assistantGrounded("Eiffel Tower"),
      msg("user", { content: "weather in London" }),
      assistantWeather("London"),
      msg("user", { content: "and Paris?" }),
    ];
    const ctx = deriveGroundedMatchContext(messages);
    expect(ctx).toEqual({ lastWeatherLocation: "London" });
    expect(ctx.lastGroundedTitle).toBeUndefined();
  });

  it("is recency-correct the other way: a more-recent Wikipedia turn beats an older weather turn", () => {
    const messages = [
      msg("user", { content: "weather in London" }),
      assistantWeather("London"),
      msg("user", { content: "tell me about Rome" }),
      assistantGrounded("Rome"),
      msg("user", { content: "how old is it?" }),
    ];
    const ctx = deriveGroundedMatchContext(messages);
    expect(ctx).toEqual({ lastGroundedTitle: "Rome" });
    expect(ctx.lastWeatherLocation).toBeUndefined();
  });

  it("returns {} for an unknown/other citation source (no antecedent — don't guess)", () => {
    const wikidataCited: ChatMessage = msg("assistant", {
      content: "From Wikidata.",
      citations: [{ id: 1, title: "Some Entity", url: "https://www.wikidata.org/wiki/Q1", source: "Wikidata" }],
    });
    const messages = [msg("user"), wikidataCited, msg("user")];
    expect(deriveGroundedMatchContext(messages)).toEqual({});
  });

  it("returns {} when no message carries a grounded citation", () => {
    const messages = [
      msg("user", { content: "write me a poem" }),
      msg("assistant", { content: "Here is a poem about leaves." }),
      msg("user", { content: "another one" }),
    ];
    expect(deriveGroundedMatchContext(messages)).toEqual({});
  });

  it("returns {} for an empty conversation", () => {
    expect(deriveGroundedMatchContext([])).toEqual({});
  });

  it("respects the recency bound: a grounded turn 7+ messages back is ignored", () => {
    // The grounded assistant sits just OUTSIDE the lookback window: with the bound
    // at 6, the last 6 messages are scanned, so a citation 7 back is not seen.
    const messages: ChatMessage[] = [
      assistantGrounded("Old Subject"), // index 0 — this is the grounded one
    ];
    for (let i = 0; i < GROUNDED_TITLE_LOOKBACK; i++) {
      messages.push(msg(i % 2 === 0 ? "user" : "assistant", { content: `filler ${i}` }));
    }
    expect(messages).toHaveLength(GROUNDED_TITLE_LOOKBACK + 1);
    expect(deriveGroundedMatchContext(messages)).toEqual({});
  });

  it("finds a grounded turn that sits exactly ON the lookback boundary", () => {
    const messages: ChatMessage[] = [assistantGrounded("Boundary Subject")];
    for (let i = 0; i < GROUNDED_TITLE_LOOKBACK - 1; i++) {
      messages.push(msg(i % 2 === 0 ? "user" : "assistant", { content: `filler ${i}` }));
    }
    expect(messages).toHaveLength(GROUNDED_TITLE_LOOKBACK);
    expect(deriveGroundedMatchContext(messages)).toEqual({ lastGroundedTitle: "Boundary Subject" });
  });

  it("ignores the in-flight streaming reply (empty, no citation) at the end", () => {
    const messages = [
      msg("user", { content: "weather in Tokyo" }),
      assistantWeather("Tokyo"),
      msg("user", { content: "what about Osaka?" }),
      msg("assistant", { id: "streaming", content: "", status: "streaming" }),
    ];
    // The empty streaming reply carries no citation, so it is skipped naturally
    // and the prior grounded subject is still found.
    expect(deriveGroundedMatchContext(messages)).toEqual({ lastWeatherLocation: "Tokyo" });
  });

  it("excludes a specified message id outright (excludeId)", () => {
    const streaming = msg("assistant", { id: "streaming", content: "" });
    const messages = [
      msg("user", { content: "about Berlin" }),
      assistantGrounded("Berlin"),
      msg("user", { content: "and?" }),
      streaming,
    ];
    expect(deriveGroundedMatchContext(messages, { excludeId: "streaming" })).toEqual({
      lastGroundedTitle: "Berlin",
    });

    const grounded = assistantGrounded("Berlin", { id: "grounded" });
    const messages2 = [msg("user"), grounded, msg("user")];
    expect(deriveGroundedMatchContext(messages2, { excludeId: "grounded" })).toEqual({});
  });

  it("ignores a citation on a USER message (only assistant turns ground)", () => {
    const userWithCitation: ChatMessage = msg("user", {
      content: "weird",
      citations: [wikiCitation("Should Not Count")],
    });
    const messages = [userWithCitation, msg("assistant", { content: "ok" })];
    expect(deriveGroundedMatchContext(messages)).toEqual({});
  });
});
