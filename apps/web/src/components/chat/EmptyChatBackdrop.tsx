// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import {
  FernIllustration,
  LeafIllustration,
  PineIllustration,
  SeedIllustration,
  SeedlingIllustration,
  SproutIllustration,
} from "@eco/ui";

/**
 * Tiny inline "grass tuft" doodle — four upward strokes from a short baseline.
 * Bespoke complement to the @eco/ui botanicals; reads as a quick pen sketch.
 */
function GrassTuft({ size = 48, opacity = 0.1 }: { size?: number; opacity?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ opacity }}
    >
      <path d="M8 40 C16 38, 32 38, 40 40" />
      <path d="M14 40 C13 32, 12 24, 14 16" />
      <path d="M20 40 C20 30, 19 20, 18 12" />
      <path d="M28 40 C28 32, 30 24, 32 18" />
      <path d="M34 40 C35 33, 36 26, 38 22" />
    </svg>
  );
}

/**
 * Tiny inline "wind curl" doodle — a single S-curve with a small flick at the end.
 * Suggests air movement; complements the rooted botanicals with something airborne.
 */
function WindCurl({ size = 64, opacity = 0.1 }: { size?: number; opacity?: number }) {
  return (
    <svg
      width={size}
      height={size * 0.5}
      viewBox="0 0 64 32"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ opacity }}
    >
      <path d="M4 18 C12 8, 24 28, 36 14 C44 6, 52 14, 58 10" />
      <path d="M58 10 C58 13, 60 14, 62 12" />
    </svg>
  );
}

/**
 * Tiny inline "seed scatter" doodle — three small dots in a constellation.
 * Adds quiet rhythm in negative-space areas without competing with text.
 */
function SeedScatter({ size = 36, opacity = 0.1 }: { size?: number; opacity?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      style={{ opacity }}
    >
      <circle cx="8" cy="12" r="2" />
      <circle cx="22" cy="6" r="1.6" />
      <circle cx="28" cy="22" r="2.2" />
      <circle cx="14" cy="26" r="1.4" />
    </svg>
  );
}

export function EmptyChatBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden [&_svg]:[stroke-width:2]"
      style={{ color: "var(--eco-primary)" }}
    >
      {/* ── TOP BAND ───────────────────────────────────────────────────── */}
      {/* Top-left: small seedling — sets tone in upper-left sky */}
      <div
        className="absolute left-[6%] top-[5%]"
        style={{ transform: "rotate(-10deg)" }}
      >
        <SeedlingIllustration size={66} style={{ opacity: 0.11 }} />
      </div>

      {/* Top-far-right: bold leaf drift */}
      <div
        className="absolute right-[4%] top-[6%]"
        style={{ transform: "rotate(28deg)" }}
      >
        <LeafIllustration size={88} style={{ opacity: 0.13 }} />
      </div>

      {/* Top-center wind curl — airborne, draws the eye across */}
      <div
        className="absolute left-[40%] top-[3%]"
        style={{ transform: "rotate(-6deg)" }}
      >
        <WindCurl size={84} opacity={0.09} />
      </div>

      {/* Top-near-right small pine */}
      <div
        className="absolute right-[22%] top-[10%]"
        style={{ transform: "rotate(-8deg)" }}
      >
        <PineIllustration size={56} style={{ opacity: 0.09 }} />
      </div>

      {/* Top-left seed scatter */}
      <div
        className="absolute left-[20%] top-[9%]"
        style={{ transform: "rotate(-14deg)" }}
      >
        <SeedScatter size={40} opacity={0.1} />
      </div>

      {/* ── MID BAND (left + right edges, away from heading/cards) ──── */}
      {/* Far-left mid fern — anchors the left edge */}
      <div
        className="absolute left-[3%] top-[38%]"
        style={{ transform: "rotate(-10deg)" }}
      >
        <FernIllustration size={150} style={{ opacity: 0.12 }} />
      </div>

      {/* Mid-right: small leaf, gently tilted */}
      <div
        className="absolute right-[5%] top-[38%]"
        style={{ transform: "rotate(34deg)" }}
      >
        <LeafIllustration size={62} style={{ opacity: 0.1 }} />
      </div>

      {/* Lower-left edge seed */}
      <div
        className="absolute bottom-[36%] left-[8%]"
        style={{ transform: "rotate(-22deg)" }}
      >
        <SeedIllustration size={48} style={{ opacity: 0.08 }} />
      </div>

      {/* ── LOWER BAND (anchored to the bottom, edges + center) ─────── */}
      {/* Anchor pine, lower-left */}
      <div
        className="absolute bottom-[8%] left-[5%]"
        style={{ transform: "rotate(-4deg)" }}
      >
        <PineIllustration size={92} style={{ opacity: 0.11 }} />
      </div>

      {/* Breathing sprout — lower-right (only animated element) */}
      <div
        className="breathe-soft absolute bottom-[8%] right-[6%]"
        style={{
          transform: "rotate(6deg)",
          ["--eco-breathe-min" as string]: "0.11",
          ["--eco-breathe-max" as string]: "0.14",
        }}
      >
        <SproutIllustration size={140} />
      </div>

      {/* Grass tuft, lower-center-left — bespoke pen-sketch detail */}
      <div
        className="absolute bottom-[5%] left-[28%]"
        style={{ transform: "rotate(-2deg)" }}
      >
        <GrassTuft size={56} opacity={0.1} />
      </div>

      {/* Tiny seedling lower-center-right */}
      <div
        className="absolute bottom-[7%] right-[28%]"
        style={{ transform: "rotate(4deg)" }}
      >
        <SeedlingIllustration size={58} style={{ opacity: 0.1 }} />
      </div>

      {/* Lower-right inset: small drifting seed */}
      <div
        className="absolute bottom-[34%] right-[14%]"
        style={{ transform: "rotate(24deg)" }}
      >
        <SeedIllustration size={42} style={{ opacity: 0.08 }} />
      </div>
    </div>
  );
}
