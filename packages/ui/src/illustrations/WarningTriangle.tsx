// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type WarningTriangleProps = {
  className?: string;
  size?: number;
};

export function WarningTriangle({ className, size }: WarningTriangleProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M10 3 L18.66 17 H1.34 Z" />
      <path d="M10 8 V12" />
      <circle cx="10" cy="14.5" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
