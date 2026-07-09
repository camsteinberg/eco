// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type IllustrationProps = {
  className?: string;
  size?: number;
  opacity?: number;
  style?: React.CSSProperties;
};

export function SeedlingIllustration({
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
      {/* Soil line */}
      <path d="M25 90 C40 88, 55 91, 60 90 C65 89, 80 91, 95 90" />

      {/* Thin stem */}
      <path d="M60 90 C60 78, 60 66, 60 55" />

      {/* Left cotyledon (seed leaf) */}
      <path d="M60 58 C52 52, 42 50, 38 54 C34 58, 40 64, 48 62 C52 61, 56 59, 60 58" />

      {/* Right cotyledon (seed leaf) */}
      <path d="M60 58 C68 52, 78 50, 82 54 C86 58, 80 64, 72 62 C68 61, 64 59, 60 58" />

      {/* Tiny emerging true leaf */}
      <path d="M60 55 C58 48, 56 42, 58 38 C60 36, 62 38, 62 42 C62 46, 61 50, 60 55" />
    </svg>
  );
}
