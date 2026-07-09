// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useEffect, useRef, useState } from "react";
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useSpring,
  useTransform,
  useReducedMotion,
} from "motion/react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WaterCounterProps = {
  liters: number;
  isDevicePrivate: boolean;
  compact?: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MILESTONES = [100, 1000, 10000] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatLiters(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)} kL`;
  return `${v.toFixed(1)} L`;
}

function formatLitersLong(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)} kiloliters`;
  return `${v.toFixed(1)} liters`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WaterCounter({
  liters,
  isDevicePrivate,
  compact = false,
}: WaterCounterProps) {
  const shouldReduce = useReducedMotion();

  // Spring-animated number
  const motionLiters = useMotionValue(0);
  const springLiters = useSpring(motionLiters, { stiffness: 100, damping: 20 });

  useEffect(() => {
    motionLiters.set(liters);
  }, [liters, motionLiters]);

  // Display value derived from spring
  const displayValue = useTransform(springLiters, (v) => formatLiters(v));

  // Droplet fill percent (0 -> 1000 maps to 0% -> 100%)
  const fillPercent = useTransform(springLiters, [0, 1000], [0, 100]);
  const fillY = useTransform(fillPercent, (p) => 32 - (p / 100) * 32);

  // Milestone ripple detection
  const prevLitersRef = useRef(liters);
  const [showRipple, setShowRipple] = useState(false);

  useEffect(() => {
    const prev = prevLitersRef.current;
    prevLitersRef.current = liters;

    if (shouldReduce) return;

    for (const milestone of MILESTONES) {
      if (prev < milestone && liters >= milestone) {
        setShowRipple(true);
        const timer = setTimeout(() => setShowRipple(false), 700);
        return () => clearTimeout(timer);
      }
    }
  }, [liters, shouldReduce]);

  const ariaLabel = `Water saved: ${formatLitersLong(liters)}`;

  return (
    <div
      className="flex items-center gap-2 text-sm font-medium text-[var(--eco-text-secondary)]"
      aria-label={ariaLabel}
      role="status"
    >
      {/* SVG Droplet with fill animation */}
      <div className="relative">
        <svg
          data-testid="water-droplet"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 32"
          className="h-6 w-[18px]"
          aria-hidden="true"
        >
          {/* Clip path for fill level */}
          <defs>
            <clipPath id="droplet-clip">
              <path d="M12 2C12 2 4 12 4 20a8 8 0 0016 0c0-8-8-18-8-18z" />
            </clipPath>
          </defs>
          {/* Fill layer (rises from bottom) */}
          <motion.rect
            x="0"
            width="24"
            height="32"
            y={shouldReduce ? 32 - (Math.min(liters / 1000, 1) * 32) : undefined}
            style={shouldReduce ? undefined : { y: fillY }}
            fill="var(--eco-accent)"
            clipPath="url(#droplet-clip)"
            opacity={0.4}
          />
          {/* Droplet outline */}
          <path
            d="M12 2C12 2 4 12 4 20a8 8 0 0016 0c0-8-8-18-8-18z"
            fill="none"
            stroke="var(--eco-accent)"
            strokeWidth={1.5}
          />
        </svg>

        {/* Milestone ripple bloom */}
        <AnimatePresence>
          {showRipple && (
            <motion.div
              data-testid="milestone-ripple"
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{
                borderColor: "var(--eco-accent)",
                borderWidth: 2,
                borderStyle: "solid",
              }}
              initial={{ scale: 1, opacity: 0.6 }}
              animate={{ scale: 2, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.6 }}
            />
          )}
        </AnimatePresence>
      </div>

      {/* Number display */}
      <div className="flex items-center gap-1.5">
        {shouldReduce ? (
          <span className="tabular-nums font-[family-name:var(--eco-font-mono)] text-[var(--eco-text)]">
            {formatLiters(liters)}
          </span>
        ) : (
          <motion.span className="tabular-nums font-[family-name:var(--eco-font-mono)] text-[var(--eco-text)]">
            {displayValue}
          </motion.span>
        )}

        {/* On-Device badge */}
        {isDevicePrivate && (
          <span className="inline-flex items-center gap-1 text-xs text-[var(--eco-success)]">
            {/* Shield icon */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="h-3 w-3"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M8 1a.75.75 0 01.538.227l5 5.25a.75.75 0 01-.076 1.082A12.944 12.944 0 018 10.5c-2.09 0-4.044-.494-5.462-1.941a.75.75 0 01-.076-1.082l5-5.25A.75.75 0 018 1zm0 12.5a14.442 14.442 0 01-5.25-1.013.75.75 0 01-.487-.782l.5-4A.75.75 0 013.5 7.1l.032.004A12.455 12.455 0 008 8.5c1.592 0 3.103-.3 4.468-.896l.032-.004a.75.75 0 01.737.605l.5 4a.75.75 0 01-.487.782A14.442 14.442 0 018 13.5z"
                clipRule="evenodd"
              />
            </svg>
            <span>On-Device</span>
          </span>
        )}

        {compact && !isDevicePrivate && (
          <span className="text-xs text-[var(--eco-text-muted)]">saved</span>
        )}
      </div>
    </div>
  );
}
