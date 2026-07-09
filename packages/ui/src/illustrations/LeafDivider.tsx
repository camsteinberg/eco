// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type IllustrationProps = {
  className?: string;
  size?: number;
  opacity?: number;
  style?: React.CSSProperties;
};

export function LeafDivider({
  className,
  size = 200,
  opacity,
  style,
}: IllustrationProps) {
  const height = Math.round((size / 200) * 40);

  return (
    <svg
      width={size}
      height={height}
      viewBox="0 0 200 40"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ ...style, ...(opacity !== undefined ? { opacity } : {}) }}
    >
      {/* Central vine tendril */}
      <path d="M30 22 C50 18, 70 24, 100 20 C130 16, 150 22, 170 20" />

      {/* Leaf 1 (left) */}
      <path d="M50 19 C46 14, 42 10, 44 7 C46 5, 50 8, 50 12 C50 15, 50 18, 50 19" />

      {/* Leaf 2 (center-left) */}
      <path d="M78 22 C82 16, 86 12, 84 9 C82 7, 78 10, 78 14 C78 17, 78 20, 78 22" />

      {/* Leaf 3 (center) */}
      <path d="M100 20 C96 14, 94 10, 96 7 C98 5, 102 5, 104 7 C106 10, 104 14, 100 20" />

      {/* Leaf 4 (center-right) */}
      <path d="M125 18 C122 12, 120 8, 122 6 C124 4, 128 7, 128 11 C128 14, 126 17, 125 18" />

      {/* Leaf 5 (right) */}
      <path d="M152 21 C156 15, 160 11, 158 8 C156 6, 152 9, 152 13 C152 16, 152 19, 152 21" />

      {/* Small curl at left end */}
      <path d="M30 22 C26 24, 22 22, 24 19" />

      {/* Small curl at right end */}
      <path d="M170 20 C174 18, 178 20, 176 23" />
    </svg>
  );
}
