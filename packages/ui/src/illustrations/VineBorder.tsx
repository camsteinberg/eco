// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type VineBorderProps = {
  className?: string;
  width?: number;
  height?: number;
  opacity?: number;
  style?: React.CSSProperties;
};

export function VineBorder({
  className,
  width = 240,
  height = 320,
  opacity,
  style,
}: VineBorderProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 240 320"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ ...style, ...(opacity !== undefined ? { opacity } : {}) }}
    >
      {/* Top-left corner vine */}
      <path d="M10 40 C10 20, 20 10, 40 10" />
      <path d="M20 10 C16 4, 12 2, 14 6 C16 10, 20 8, 20 10" />
      <path d="M30 10 C28 4, 26 0, 28 2 C30 4, 32 8, 30 10" />

      {/* Top edge */}
      <path d="M40 10 C80 8, 120 12, 160 10 C200 8, 220 10, 230 10" />

      {/* Top-right corner vine */}
      <path d="M230 10 C238 10, 240 20, 240 40" />
      <path d="M232 16 C236 12, 240 10, 238 14 C236 18, 232 16, 232 16" />

      {/* Right edge (partial - open) */}
      <path d="M240 40 C238 80, 240 120, 238 160" />

      {/* Bottom-right leaf accent */}
      <path d="M238 160 C234 164, 230 166, 232 162 C234 158, 238 158, 238 160" />

      {/* Bottom edge (partial - open, creating incomplete feel) */}
      <path d="M200 310 C160 312, 120 308, 80 310 C60 311, 40 310, 20 310" />

      {/* Bottom-left corner vine */}
      <path d="M20 310 C10 310, 10 300, 10 280" />
      <path d="M10 300 C6 304, 4 308, 6 306 C8 304, 12 302, 10 300" />

      {/* Left edge (partial - open) */}
      <path d="M10 280 C12 240, 10 200, 12 160 C10 120, 12 80, 10 40" />

      {/* Corner leaf accents */}
      {/* Top-left leaf */}
      <path d="M14 30 C8 26, 4 22, 6 18 C8 16, 12 18, 12 22 C12 26, 14 28, 14 30" />

      {/* Top-right leaf */}
      <path d="M236 30 C240 26, 244 22, 242 18 C240 16, 236 18, 236 22 C236 26, 236 28, 236 30" />

      {/* Bottom-left leaf */}
      <path d="M14 290 C8 294, 4 298, 6 302 C8 304, 12 302, 12 298 C12 294, 14 292, 14 290" />

      {/* Small vine tendril at the open gaps */}
      <path d="M238 160 C240 170, 238 180, 240 190" />
      <path d="M200 310 C210 312, 220 310, 228 308" />
    </svg>
  );
}
