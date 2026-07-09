// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type IllustrationProps = {
  className?: string;
  size?: number;
  opacity?: number;
  style?: React.CSSProperties;
};

export function TreeIllustration({
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
      <path d="M10 98 C30 96, 50 99, 60 98 C70 97, 90 99, 110 97" />

      {/* Sturdy trunk */}
      <path d="M55 98 C55 88, 54 78, 54 68" />
      <path d="M65 98 C65 88, 66 78, 66 68" />

      {/* Main branches spreading */}
      <path d="M54 68 C48 62, 38 56, 28 52" />
      <path d="M66 68 C72 62, 82 56, 92 52" />
      <path d="M56 62 C50 56, 40 48, 32 42" />
      <path d="M64 62 C70 56, 80 48, 88 42" />
      <path d="M58 56 C54 50, 48 42, 44 36" />
      <path d="M62 56 C66 50, 72 42, 76 36" />

      {/* Canopy leaves - left side */}
      <path d="M28 52 C24 48, 22 42, 26 38 C28 36, 32 38, 30 42 C29 46, 28 50, 28 52" />
      <path d="M32 42 C26 38, 22 32, 24 28 C26 26, 30 28, 30 32 C30 36, 31 40, 32 42" />
      <path d="M44 36 C40 30, 38 24, 42 20 C44 18, 48 20, 46 24 C45 28, 44 32, 44 36" />

      {/* Canopy leaves - center */}
      <path d="M56 38 C52 32, 52 26, 56 22 C58 20, 62 22, 60 26 C59 30, 58 34, 56 38" />
      <path d="M60 34 C58 28, 58 22, 60 18 C62 16, 64 18, 64 22 C64 26, 62 30, 60 34" />
      <path d="M64 38 C68 32, 68 26, 64 22 C62 20, 58 22, 60 26 C61 30, 62 34, 64 38" />

      {/* Canopy leaves - right side */}
      <path d="M92 52 C96 48, 98 42, 94 38 C92 36, 88 38, 90 42 C91 46, 92 50, 92 52" />
      <path d="M88 42 C94 38, 98 32, 96 28 C94 26, 90 28, 90 32 C90 36, 89 40, 88 42" />
      <path d="M76 36 C80 30, 82 24, 78 20 C76 18, 72 20, 74 24 C75 28, 76 32, 76 36" />

      {/* Floating leaves (gently drifting down) */}
      <path d="M36 70 C34 68, 32 70, 34 72 C36 74, 38 72, 36 70" />
      <path d="M82 76 C80 74, 78 76, 80 78 C82 80, 84 78, 82 76" />
      <path d="M46 84 C44 82, 42 84, 44 86 C46 88, 48 86, 46 84" />

      {/* Spreading roots */}
      <path d="M55 98 C48 102, 38 104, 28 106" />
      <path d="M65 98 C72 102, 82 104, 92 106" />
      <path d="M58 100 C52 103, 44 104, 36 106" />
      <path d="M62 100 C68 103, 76 104, 84 106" />
    </svg>
  );
}
