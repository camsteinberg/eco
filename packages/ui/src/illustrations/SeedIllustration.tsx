// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type IllustrationProps = {
  className?: string;
  size?: number;
  opacity?: number;
  style?: React.CSSProperties;
};

export function SeedIllustration({
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
      {/* Earth contour lines */}
      <path d="M20 72 C35 70, 50 73, 65 71 C80 69, 95 72, 105 70" />
      <path d="M15 82 C30 79, 50 83, 65 80 C82 77, 95 81, 110 78" />
      <path d="M18 92 C38 89, 55 93, 70 90 C85 87, 98 91, 108 88" />

      {/* Seed body - oval nestled in soil */}
      <path d="M52 62 C52 54, 56 48, 60 46 C64 48, 68 54, 68 62 C68 68, 64 72, 60 73 C56 72, 52 68, 52 62" />

      {/* Seed ridge line */}
      <path d="M60 48 C59 54, 59 62, 60 70" />

      {/* Small root tendril emerging from bottom */}
      <path d="M60 73 C58 78, 56 84, 54 90" />
      <path d="M58 80 C55 83, 52 85, 50 88" />

      {/* Tiny crack at top suggesting life about to emerge */}
      <path d="M58 48 C59 46, 61 46, 62 48" />
    </svg>
  );
}
