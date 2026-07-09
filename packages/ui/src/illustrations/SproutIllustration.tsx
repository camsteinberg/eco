// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type IllustrationProps = {
  className?: string;
  size?: number;
  opacity?: number;
  style?: React.CSSProperties;
};

export function SproutIllustration({
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
      <path d="M20 82 C35 80, 48 83, 60 82 C72 81, 85 83, 100 81" />

      {/* Thin stem - slightly curved for organic feel */}
      <path d="M60 82 C59 72, 58 62, 57 52" />

      {/* Left cotyledon leaf */}
      <path d="M57 55 C50 48, 40 44, 35 47 C32 50, 36 56, 44 55 C48 54, 53 54, 57 55" />

      {/* Left leaf vein */}
      <path d="M57 55 C50 52, 43 50, 37 49" />

      {/* Right cotyledon leaf */}
      <path d="M57 55 C64 48, 74 44, 79 47 C82 50, 78 56, 70 55 C66 54, 61 54, 57 55" />

      {/* Right leaf vein */}
      <path d="M57 55 C64 52, 71 50, 77 49" />

      {/* Small roots below soil */}
      <path d="M60 82 C58 88, 55 94, 52 98" />
      <path d="M60 82 C62 87, 65 92, 68 96" />
      <path d="M59 86 C56 89, 53 90, 50 92" />
    </svg>
  );
}
