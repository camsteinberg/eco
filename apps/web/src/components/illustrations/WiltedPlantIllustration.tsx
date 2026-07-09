// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type WiltedPlantIllustrationProps = {
  className?: string;
  perking?: boolean;
};

export function WiltedPlantIllustration({
  className,
  perking = false,
}: WiltedPlantIllustrationProps) {
  return (
    <div
      className={[
        "inline-flex transition-transform duration-500",
        perking ? "perk-up" : "",
      ].join(" ")}
      style={{
        transform: perking
          ? "rotate(0deg) scale(1.05)"
          : "rotate(15deg) scale(0.9)",
        filter: perking ? "saturate(1.3)" : "saturate(0.7)",
        transitionProperty: "transform, filter",
      }}
    >
      <svg
        width="64"
        height="64"
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className={className}
      >
        {/* Ground */}
        <ellipse
          cx="32"
          cy="56"
          rx="16"
          ry="3"
          fill="var(--eco-primary-soft)"
        />
        {/* Stem — curving to the right (drooping) */}
        <path
          d="M32 56 C32 48 34 42 36 36 C38 30 38 26 36 22"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
        {/* Left leaf — drooping down */}
        <path
          d="M34 40 C28 42 24 44 22 48 C26 46 30 42 34 40Z"
          fill="var(--eco-primary)"
          opacity="0.5"
        />
        {/* Right leaf — drooping down */}
        <path
          d="M36 34 C40 38 42 42 44 46 C42 40 40 36 36 34Z"
          fill="var(--eco-primary)"
          opacity="0.6"
        />
        {/* Top leaf — wilting over */}
        <path
          d="M36 22 C38 18 42 16 44 14 C40 16 36 18 36 22Z"
          fill="var(--eco-primary)"
          opacity="0.7"
        />
        {/* Leaf veins */}
        <path
          d="M34 40 C30 42 26 44 22 48"
          stroke="var(--eco-primary-soft)"
          strokeWidth="0.5"
          fill="none"
        />
        <path
          d="M36 34 C38 38 40 42 44 46"
          stroke="var(--eco-primary-soft)"
          strokeWidth="0.5"
          fill="none"
        />
      </svg>
    </div>
  );
}
