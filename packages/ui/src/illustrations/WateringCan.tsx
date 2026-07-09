// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type IllustrationProps = {
  className?: string;
  size?: number;
  opacity?: number;
  style?: React.CSSProperties;
};

export function WateringCan({
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
      {/* Watering can body (rounded, friendly shape) */}
      <path d="M30 55 C30 48, 34 42, 42 40 L78 40 C86 42, 90 48, 90 55 L88 75 C88 80, 84 84, 78 84 L42 84 C36 84, 32 80, 32 75 Z" />

      {/* Handle (arched, handmade feel) */}
      <path d="M42 40 C40 30, 44 22, 54 20 C64 18, 74 22, 76 32 C77 36, 78 38, 78 40" />

      {/* Spout */}
      <path d="M90 50 C96 46, 102 40, 108 34" />
      <path d="M90 56 C96 52, 102 46, 108 40" />

      {/* Spout tip (shower head) */}
      <path d="M108 34 C110 32, 112 34, 110 36 C108 38, 108 40" />

      {/* Water drops falling from spout */}
      <path d="M106 44 C105 46, 106 48, 107 47" />
      <path d="M102 50 C101 52, 102 54, 103 53" />
      <path d="M108 52 C107 54, 108 56, 109 55" />
      <path d="M104 58 C103 60, 104 62, 105 61" />
      <path d="M100 56 C99 58, 100 60, 101 59" />

      {/* Small plant receiving water */}
      <path d="M100 90 C100 82, 100 76, 100 70" />
      <path d="M100 76 C94 72, 90 68, 88 64 C90 66, 94 70, 100 74" />
      <path d="M100 72 C106 68, 110 64, 112 60 C110 62, 106 66, 100 70" />

      {/* Ground for the plant */}
      <path d="M88 90 C94 88, 100 90, 106 88 C110 87, 112 89, 114 88" />
    </svg>
  );
}
