// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useSettingsStore } from "../../stores/settingsStore";

/**
 * The composer's **Web** switch — the person's standing decision about whether
 * Eco may look something up.
 *
 * It replaces the greyed "Research" pill (a "coming later" affordance) with a
 * real `role="switch"` bound to the persisted `webSearchEnabled` setting. Off by
 * default. With it on, a turn the host reads as a question about right now is
 * searched through Eco's own relay BEFORE the reply, with no extra press, and
 * the reply carries a chip naming the time and the sources.
 *
 * It is the SAME setting as the Settings → Eco row: one setting, two switches,
 * so flipping either moves both. Visible at every width (a phone is where a
 * live question is most likely asked); below `sm` the label collapses and the
 * magnifier alone carries it, with the accessible name doing the work.
 */
export function WebSearchToggle() {
  const webSearchEnabled = useSettingsStore((state) => state.webSearchEnabled);
  const setWebSearchEnabled = useSettingsStore((state) => state.setWebSearchEnabled);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={webSearchEnabled}
      data-testid="web-search-toggle"
      aria-label={webSearchEnabled ? "Web search: on" : "Web search: off"}
      title="When on, Eco searches the web for questions about right now. Only the search terms go to Eco's relay."
      onClick={() => {
        setWebSearchEnabled(!webSearchEnabled);
      }}
      className={`flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-medium transition-[color,border-color,background-color] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--eco-primary)] ${
        webSearchEnabled
          ? "border-[var(--eco-primary)] text-[var(--eco-primary)]"
          : "border-[var(--eco-border)] text-[var(--eco-text-secondary)] hover:text-[var(--eco-text)]"
      }`}
    >
      <span className="flex items-center" aria-hidden="true">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-3.5 w-3.5"
        >
          <path
            fillRule="evenodd"
            d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
            clipRule="evenodd"
          />
        </svg>
      </span>
      <span className="hidden sm:inline">Web</span>
    </button>
  );
}
