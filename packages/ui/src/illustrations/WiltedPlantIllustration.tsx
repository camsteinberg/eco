// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type IllustrationProps = {
  className?: string;
  size?: number;
  opacity?: number;
  style?: React.CSSProperties;
};

export function WiltedPlantIllustration({
  className,
  size = 120,
  opacity,
  style,
}: IllustrationProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ ...style, ...(opacity !== undefined ? { opacity } : {}) }}
    >
      {/* Ground */}
      <ellipse cx="32" cy="56" rx="16" ry="3" />

      {/* Stem - curving to the right (drooping) */}
      <path d="M32 56 C32 48 34 42 36 36 C38 30 38 26 36 22" />

      {/* Left leaf - drooping down */}
      <path d="M34 40 C28 42 24 44 22 48 C26 46 30 42 34 40Z" />

      {/* Right leaf - drooping down */}
      <path d="M36 34 C40 38 42 42 44 46 C42 40 40 36 36 34Z" />

      {/* Top leaf - wilting over */}
      <path d="M36 22 C38 18 42 16 44 14 C40 16 36 18 36 22Z" />

      {/* Leaf veins */}
      <path d="M34 40 C30 42 26 44 22 48" />
      <path d="M36 34 C38 38 40 42 44 46" />
    </svg>
  );
}
