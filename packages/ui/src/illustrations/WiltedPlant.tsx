// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type IllustrationProps = {
  className?: string;
  size?: number;
  opacity?: number;
  style?: React.CSSProperties;
};

export function WiltedPlant({
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
      {/* Soil / ground */}
      <path d="M30 90 C45 88, 55 91, 60 90 C65 89, 75 91, 90 89" />

      {/* Stem - drooping curve to the right */}
      <path d="M60 90 C60 80, 62 70, 66 60 C70 50, 72 44, 70 38" />

      {/* Left leaf - hanging down sadly */}
      <path d="M64 65 C56 68, 48 72, 44 78 C48 74, 54 70, 64 65" />

      {/* Right leaf - drooping */}
      <path d="M68 55 C76 60, 80 66, 84 74 C80 64, 76 58, 68 55" />

      {/* Top leaf - wilting over */}
      <path d="M70 38 C74 34, 78 30, 82 28 C78 32, 74 34, 70 38" />

      {/* Slightly perked leaf (hope) */}
      <path d="M66 48 C60 42, 54 38, 50 34 C52 36, 56 40, 62 44" />

      {/* Small drip from a leaf (single tear) */}
      <path d="M44 78 C43 80, 44 82, 45 81" />

      {/* Tiny root showing */}
      <path d="M60 90 C58 94, 55 97, 52 100" />
      <path d="M60 90 C62 94, 65 96, 68 98" />
    </svg>
  );
}
