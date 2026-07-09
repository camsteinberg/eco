// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type PineIllustrationProps = {
  className?: string;
  style?: React.CSSProperties;
};

export function PineIllustration({ className, style }: PineIllustrationProps) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={style}
    >
      {/* Trunk */}
      <path d="M57 100 L57 80" />
      <path d="M63 100 L63 80" />

      {/* Bottom tier (widest) */}
      <path d="M30 82 L60 58 L90 82 Z" />

      {/* Middle tier */}
      <path d="M36 66 L60 44 L84 66 Z" />

      {/* Top tier (smallest) */}
      <path d="M42 50 L60 30 L78 50 Z" />

      {/* Star / top accent */}
      <path d="M60 30 L60 24" />
    </svg>
  );
}
