// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type IllustrationProps = {
  className?: string;
  size?: number;
  opacity?: number;
  style?: React.CSSProperties;
};

export function ForestClearing({
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
      {/* Ground plane */}
      <path d="M10 95 C30 92, 50 96, 60 94 C70 92, 90 96, 110 93" />

      {/* Left tree trunk (partial, at edge) */}
      <path d="M15 95 C15 80, 14 65, 14 50" />
      <path d="M20 95 C20 82, 19 68, 18 55" />

      {/* Left tree branches */}
      <path d="M15 60 C10 54, 5 50, 2 48" />
      <path d="M16 52 C12 46, 8 42, 4 40" />

      {/* Left tree leaves */}
      <path d="M2 48 C0 44, 2 40, 6 42 C8 43, 6 46, 2 48" />
      <path d="M4 40 C2 36, 4 32, 8 34 C10 35, 8 38, 4 40" />

      {/* Right tree trunk (partial, at edge) */}
      <path d="M100 95 C100 78, 101 62, 102 48" />
      <path d="M106 95 C106 80, 107 66, 108 52" />

      {/* Right tree branches */}
      <path d="M104 58 C110 52, 114 48, 118 46" />
      <path d="M103 50 C108 44, 112 40, 116 38" />

      {/* Right tree leaves */}
      <path d="M118 46 C120 42, 118 38, 114 40 C112 41, 114 44, 118 46" />
      <path d="M116 38 C118 34, 116 30, 112 32 C110 33, 112 36, 116 38" />

      {/* Scattered leaves on the ground */}
      <path d="M35 92 C33 90, 35 88, 37 90 C39 91, 37 93, 35 92" />
      <path d="M55 94 C53 92, 55 90, 57 92 C59 93, 57 95, 55 94" />
      <path d="M75 91 C73 89, 75 87, 77 89 C79 90, 77 92, 75 91" />
      <path d="M88 93 C86 91, 88 89, 90 91 C92 92, 90 94, 88 93" />

      {/* Small fern in the clearing */}
      <path d="M60 94 C60 90, 59 86, 58 82" />
      <path d="M59 86 C55 84, 52 85, 54 87" />
      <path d="M59 83 C63 81, 66 82, 64 84" />

      {/* Dappled light suggestion (soft arcs above) */}
      <path d="M40 30 C50 25, 60 28, 70 25 C80 22, 85 26, 90 24" />
      <path d="M30 38 C38 34, 48 36, 55 34" />
    </svg>
  );
}
