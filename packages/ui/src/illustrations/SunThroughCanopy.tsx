// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type IllustrationProps = {
  className?: string;
  size?: number;
  opacity?: number;
  style?: React.CSSProperties;
};

export function SunThroughCanopy({
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
      {/* Sun circle (partial, at top center gap) */}
      <path d="M50 18 C50 10, 56 5, 60 5 C64 5, 70 10, 70 18" />

      {/* Sun rays radiating downward through the gap */}
      <line x1="60" y1="18" x2="60" y2="50" />
      <line x1="52" y1="20" x2="40" y2="55" />
      <line x1="68" y1="20" x2="80" y2="55" />
      <line x1="55" y1="19" x2="48" y2="52" />
      <line x1="65" y1="19" x2="72" y2="52" />

      {/* Shorter rays (warmth) */}
      <line x1="58" y1="22" x2="54" y2="38" />
      <line x1="62" y1="22" x2="66" y2="38" />

      {/* Left canopy branches and leaves */}
      <path d="M0 15 C10 12, 20 16, 30 14 C38 12, 44 14, 48 16" />
      <path d="M5 22 C15 18, 22 22, 30 20 C36 18, 42 20, 46 22" />

      {/* Left canopy leaves */}
      <path d="M15 14 C12 8, 14 4, 18 6 C20 8, 18 12, 15 14" />
      <path d="M30 14 C28 8, 30 4, 34 6 C36 8, 34 12, 30 14" />
      <path d="M10 22 C8 18, 10 14, 14 16 C16 18, 14 20, 10 22" />

      {/* Right canopy branches and leaves */}
      <path d="M72 16 C78 14, 84 16, 92 14 C100 12, 108 16, 120 15" />
      <path d="M74 22 C80 20, 86 22, 94 20 C100 18, 108 20, 118 22" />

      {/* Right canopy leaves */}
      <path d="M85 14 C82 8, 84 4, 88 6 C90 8, 88 12, 85 14" />
      <path d="M100 14 C98 8, 100 4, 104 6 C106 8, 104 12, 100 14" />
      <path d="M110 22 C108 18, 110 14, 114 16 C116 18, 114 20, 110 22" />

      {/* Light particles / motes in the rays (warmth feel) */}
      <circle cx="56" cy="42" r="1" />
      <circle cx="64" cy="36" r="1" />
      <circle cx="60" cy="60" r="1.5" />
      <circle cx="52" cy="48" r="1" />
      <circle cx="68" cy="46" r="1" />

      {/* Ground foliage catching the light */}
      <path d="M35 95 C40 88, 45 84, 50 86 C55 88, 55 92, 50 94 C45 96, 40 96, 35 95" />
      <path d="M65 95 C70 88, 75 84, 80 86 C85 88, 85 92, 80 94 C75 96, 70 96, 65 95" />
      <path d="M48 100 C54 94, 60 92, 66 94 C72 96, 72 100, 66 102 C60 104, 54 102, 48 100" />
    </svg>
  );
}
