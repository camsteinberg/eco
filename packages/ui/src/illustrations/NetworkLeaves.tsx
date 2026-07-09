// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type IllustrationProps = {
  className?: string;
  size?: number;
  opacity?: number;
  style?: React.CSSProperties;
};

export function NetworkLeaves({
  className,
  size = 120,
  opacity,
  style,
}: IllustrationProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ ...style, ...(opacity !== undefined ? { opacity } : {}) }}
    >
      {/* Central connecting stems (the network) */}
      <path d="M60 60 C48 50, 34 42, 26 34" />
      <path d="M60 60 C72 48, 82 38, 90 30" />
      <path d="M60 60 C52 72, 40 80, 30 86" />
      <path d="M60 60 C70 72, 80 82, 88 90" />

      {/* Leaf 1 (top-left, large) */}
      <path d="M26 34 C20 28, 16 20, 20 14 C22 10, 28 12, 28 18 C28 24, 26 30, 26 34" />
      <path d="M26 34 C22 30, 18 24, 18 18" />

      {/* Leaf 2 (top-right, medium) */}
      <path d="M90 30 C94 24, 96 18, 92 14 C90 12, 86 14, 86 18 C86 22, 88 26, 90 30" />
      <path d="M90 30 C92 26, 92 20, 90 16" />

      {/* Leaf 3 (bottom-left, small) */}
      <path d="M30 86 C26 90, 22 92, 24 96 C26 98, 30 96, 30 92 C30 90, 30 88, 30 86" />
      <path d="M30 86 C28 90, 26 92, 26 95" />

      {/* Leaf 4 (bottom-right, medium-large) */}
      <path d="M88 90 C94 94, 100 98, 100 104 C100 108, 94 108, 92 104 C90 100, 88 96, 88 90" />
      <path d="M88 90 C92 96, 96 100, 98 104" />

      {/* Central node (small circle suggesting a hub) */}
      <circle cx="60" cy="60" r="3" />

      {/* Secondary connection lines (mesh feel) */}
      <path d="M26 34 C40 30, 70 28, 90 30" strokeDasharray="3 4" />
      <path d="M30 86 C50 84, 70 86, 88 90" strokeDasharray="3 4" />
    </svg>
  );
}
