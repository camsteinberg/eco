// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import type { MessageReaction } from "../../lib/db";

const REACTION_OPTIONS = [
  { emoji: "thumbs-up", label: "Helpful", symbol: "\u{1F44D}" },
  { emoji: "thumbs-down", label: "Not helpful", symbol: "\u{1F44E}" },
  { emoji: "heart", label: "Love it", symbol: "\u{2764}\u{FE0F}" },
  { emoji: "leaf", label: "Eco!", symbol: "\u{1F33F}" },
] as const;

type MessageReactionsProps = {
  reactions: MessageReaction[];
  onReact: (emoji: string) => void;
  onRemoveReaction: (emoji: string) => void;
};

export function MessageReactions({
  reactions,
  onReact,
  onRemoveReaction,
}: MessageReactionsProps) {
  const hasActiveReactions = reactions.length > 0;

  const isActive = (emoji: string) =>
    reactions.some((r) => r.emoji === emoji);

  return (
    <div
      className={[
        "flex items-center gap-1 transition-opacity",
        hasActiveReactions
          ? "opacity-100"
          : "opacity-0 group-hover:opacity-100",
      ].join(" ")}
    >
      <style>{`
        @keyframes leaf-flutter {
          0% { transform: rotate(0deg); }
          25% { transform: rotate(15deg); }
          50% { transform: rotate(-15deg); }
          75% { transform: rotate(10deg); }
          100% { transform: rotate(0deg) scale(1.1); }
        }
        .leaf-flutter {
          animation: leaf-flutter 400ms ease-out forwards;
        }
        @media (prefers-reduced-motion: reduce) {
          .leaf-flutter {
            animation: none;
            transform: scale(1.1);
          }
        }
      `}</style>
      {REACTION_OPTIONS.map((option) => {
        const active = isActive(option.emoji);
        const isLeaf = option.emoji === "leaf";

        return (
          <button
            key={option.emoji}
            type="button"
            aria-label={option.label}
            onClick={() => {
              if (active) {
                onRemoveReaction(option.emoji);
              } else {
                onReact(option.emoji);
              }
            }}
            className={[
              "flex items-center justify-center rounded-full text-sm transition-transform duration-150",
              "h-7 w-7 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0",
              active
                ? "active scale-110 bg-[var(--eco-accent-soft)]"
                : "hover:bg-[var(--eco-surface-elevated)] hover:scale-110",
              active && isLeaf ? "leaf-flutter" : "",
            ].join(" ")}
          >
            <span className="text-base">{option.symbol}</span>
          </button>
        );
      })}
    </div>
  );
}
