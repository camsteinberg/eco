// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

/**
 * The host-side crisis-resource card.
 *
 * When a person's own message explicitly says they are thinking about ending their life
 * or hurting themselves, the host puts these four lines above the reply. It is the one
 * place where Eco adds something of its own to a turn, and it is deliberately the
 * smallest possible thing: a fixed, static card of phone numbers and links.
 *
 * What it is NOT: a filter, a refusal, a classifier, or a model behaviour. The reply
 * streams exactly as it would have. Nothing is blocked or rewritten, no system prompt
 * changes, no request leaves the device, and nothing is recorded — the card is rendered
 * from the text already on screen and forgotten when the view unmounts.
 *
 * Register: plain and quiet. A 1–2B model on a laptop is not a crisis counsellor and
 * should not be mistaken for one, so the card's job is to put a real, staffed line in
 * front of someone in under a second. Amber accent, not red: this is care, not an alarm.
 * No motion at all, in any preference — an animation here would be theatre.
 */
export function CrisisResourceCard() {
  return (
    <aside
      role="note"
      aria-label="Support resources"
      data-testid="crisis-resource-card"
      className="mb-3 rounded-[var(--eco-radius-md)] border border-[var(--eco-border)] border-l-2 border-l-[var(--eco-amber)] px-3 py-2.5"
      style={{ backgroundColor: "var(--eco-surface-elevated)" }}
    >
      <p
        className="text-[13px] font-medium leading-relaxed"
        style={{ color: "var(--eco-text)", fontFamily: "var(--eco-font-body)" }}
      >
        If you&apos;re thinking about harming yourself, you deserve support right now.
      </p>
      <ul
        className="mt-1.5 space-y-1 text-[13px] leading-relaxed"
        style={{ color: "var(--eco-text-secondary)", fontFamily: "var(--eco-font-body)" }}
      >
        <li>
          In the US, call or text{" "}
          <a
            href="https://988lifeline.org"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline decoration-dotted underline-offset-2 transition-colors hover:decoration-solid"
            style={{ color: "var(--eco-amber)" }}
          >
            988
          </a>{" "}
          (Suicide &amp; Crisis Lifeline).
        </li>
        <li>
          Elsewhere:{" "}
          <a
            href="https://findahelpline.com"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline decoration-dotted underline-offset-2 transition-colors hover:decoration-solid"
            style={{ color: "var(--eco-amber)" }}
          >
            findahelpline.com
          </a>{" "}
          lists free, confidential lines by country.
        </li>
        <li>If you&apos;re in immediate danger, call your local emergency number.</li>
      </ul>
    </aside>
  );
}
