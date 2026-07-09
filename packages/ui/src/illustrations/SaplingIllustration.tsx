// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type IllustrationProps = {
  className?: string;
  size?: number;
  opacity?: number;
  style?: React.CSSProperties;
};

export function SaplingIllustration({
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
      {/* Ground line */}
      <path d="M18 92 C35 90, 50 93, 60 92 C70 91, 85 93, 102 91" />

      {/* Slender trunk */}
      <path d="M60 92 C60 80, 59 68, 58 55" />

      {/* Left branch with leaf */}
      <path d="M59 72 C52 68, 44 66, 38 68" />
      <path d="M38 68 C34 62, 32 56, 35 52 C38 50, 42 54, 40 58 C39 62, 38 66, 38 68" />

      {/* Right branch with leaf */}
      <path d="M59 65 C66 61, 74 60, 80 62" />
      <path d="M80 62 C84 56, 84 50, 80 48 C76 47, 74 52, 76 56 C78 59, 79 61, 80 62" />

      {/* Upper left branch with leaf */}
      <path d="M58 58 C52 54, 46 52, 42 54" />
      <path d="M42 54 C38 50, 38 44, 42 42 C44 41, 46 44, 44 48 C43 51, 42 53, 42 54" />

      {/* Upper right branch with leaf */}
      <path d="M58 55 C64 50, 70 48, 74 50" />
      <path d="M74 50 C78 44, 76 38, 72 37 C68 36, 68 40, 70 44 C71 47, 73 49, 74 50" />

      {/* Top leaf pair (newest growth) */}
      <path d="M58 55 C56 48, 54 42, 56 38 C58 36, 60 38, 60 42 C60 46, 59 50, 58 55" />
      <path d="M58 55 C60 48, 62 42, 64 40 C66 39, 66 42, 64 46 C62 50, 60 53, 58 55" />

      {/* Visible roots */}
      <path d="M60 92 C56 96, 50 100, 44 102" />
      <path d="M60 92 C64 96, 70 100, 76 102" />
      <path d="M58 94 C54 98, 48 99, 42 100" />
    </svg>
  );
}
