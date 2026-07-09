// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type LeafIllustrationProps = {
  className?: string;
  style?: React.CSSProperties;
};

export function LeafIllustration({ className, style }: LeafIllustrationProps) {
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
      {/* Leaf outline */}
      <path d="M60 20 C40 30, 25 50, 28 70 C30 82, 42 92, 60 95 C78 92, 90 82, 92 70 C95 50, 80 30, 60 20 Z" />

      {/* Main vein (midrib) */}
      <path d="M60 25 L60 95" />

      {/* Secondary veins - left side */}
      <path d="M60 40 C52 38, 42 42, 36 48" />
      <path d="M60 55 C50 52, 40 56, 32 62" />
      <path d="M60 70 C50 68, 42 72, 36 78" />

      {/* Secondary veins - right side */}
      <path d="M60 40 C68 38, 78 42, 84 48" />
      <path d="M60 55 C70 52, 80 56, 88 62" />
      <path d="M60 70 C70 68, 78 72, 84 78" />

      {/* Stem */}
      <path d="M60 95 C58 100, 54 105, 50 108" />
    </svg>
  );
}
