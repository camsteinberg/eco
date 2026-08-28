// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type DemotionDividerProps = {
  fromLabel: string;
  toLabel: string;
};

export function DemotionDivider({ fromLabel, toLabel }: DemotionDividerProps) {
  const message = `Answering with ${toLabel} — a smaller model — because ${fromLabel} couldn't start on this device right now. You can get ${fromLabel} back in Settings.`;

  return (
    <div
      className="my-3 flex items-center gap-3"
      role="separator"
      aria-label={message}
    >
      <div
        className="h-px flex-1"
        style={{ backgroundColor: "var(--eco-border, #e5e0d8)" }}
      />

      <div className="flex shrink-0 items-center gap-1.5">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-3.5 w-3.5"
          style={{ color: "var(--eco-accent, #2d5a3d)", opacity: 0.6 }}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M2 4.25A2.25 2.25 0 014.25 2h11.5A2.25 2.25 0 0118 4.25v8.5A2.25 2.25 0 0115.75 15h-3.105a3.501 3.501 0 001.1 1.677A.75.75 0 0113.26 18H6.74a.75.75 0 01-.484-1.323A3.501 3.501 0 007.355 15H4.25A2.25 2.25 0 012 12.75v-8.5zm1.5 0a.75.75 0 01.75-.75h11.5a.75.75 0 01.75.75v7.5a.75.75 0 01-.75.75H4.25a.75.75 0 01-.75-.75v-7.5z"
            clipRule="evenodd"
          />
        </svg>
        <span
          className="text-[11px] font-medium tracking-wide"
          style={{ color: "var(--eco-text-secondary, #6b5e4f)" }}
        >
          {message}
        </span>
      </div>

      <div
        className="h-px flex-1"
        style={{ backgroundColor: "var(--eco-border, #e5e0d8)" }}
      />
    </div>
  );
}
