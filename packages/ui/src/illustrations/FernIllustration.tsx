// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type IllustrationProps = {
  className?: string;
  size?: number;
  opacity?: number;
  style?: React.CSSProperties;
};

export function FernIllustration({
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
      {/* Central stem */}
      <path d="M60 105 C60 85, 58 60, 55 30" />

      {/* Leaflet pairs - alternating sides, curving outward */}
      {/* Pair 1 (bottom) */}
      <path d="M58 80 C48 72, 35 70, 28 75" />
      <path d="M59 78 C68 70, 80 68, 88 72" />

      {/* Pair 2 */}
      <path d="M57 66 C48 58, 38 55, 30 58" />
      <path d="M58 64 C66 56, 76 53, 84 55" />

      {/* Pair 3 */}
      <path d="M57 52 C49 46, 42 42, 36 44" />
      <path d="M57 50 C64 44, 72 40, 78 41" />

      {/* Pair 4 */}
      <path d="M56 40 C50 35, 45 32, 40 33" />
      <path d="M56 38 C62 33, 68 30, 73 30" />

      {/* Pair 5 (top - smaller) */}
      <path d="M55 32 C52 28, 49 26, 46 27" />
      <path d="M56 30 C58 26, 62 24, 65 24" />

      {/* Curled tip (fiddlehead) */}
      <path d="M55 30 C53 24, 52 20, 54 18 C56 16, 59 17, 58 20" />
    </svg>
  );
}
