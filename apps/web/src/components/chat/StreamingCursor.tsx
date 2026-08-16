// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { motion, useReducedMotion } from "motion/react";
import type { StreamPhase } from "../../stores/chatStore";

type StreamingCursorProps = {
  phase?: StreamPhase;
};

/**
 * Calm "warming up" indicator for the model cold-load window (loading state).
 *
 * The model is loading its weights + compiling WebGPU shaders before the first
 * token — a multi-second wait that must read as honest preparation, not a hang.
 * Botanical motif: a single seed/bud that gently breathes inside a soft halo,
 * evoking warmth gathering before the response sprouts. Slower and softer than
 * the staccato ThinkingDots so the two states feel distinct. Motion v12 ambient
 * pulse (no eased curve, per the motion rule); collapses to a static
 * dot under prefers-reduced-motion.
 */
function LoadingCursor() {
  const shouldReduce = useReducedMotion();

  return (
    <span
      data-testid="streaming-cursor"
      data-loading="true"
      className="ml-0.5 inline-flex items-center align-middle"
      aria-hidden="true"
    >
      <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center">
        {/* Soft breathing halo — warmth gathering around the seed. */}
        <motion.span
          className="absolute inset-0 rounded-full bg-[var(--eco-accent)]/25"
          animate={shouldReduce ? {} : { scale: [1, 1.8, 1], opacity: [0.35, 0, 0.35] }}
          transition={{ duration: 2, repeat: Infinity }}
        />
        {/* The seed/bud at rest, breathing gently. */}
        <motion.span
          className="relative h-2 w-2 rounded-full bg-[var(--eco-accent)]"
          animate={shouldReduce ? {} : { scale: [1, 1.25, 1] }}
          transition={{ duration: 2, repeat: Infinity }}
        />
      </span>
      <span className="sr-only">Preparing model...</span>
    </span>
  );
}

/** Breathing dots using Motion v12 organic grow/shrink pulse for thinking/queued states. */
function ThinkingDots() {
  const shouldReduce = useReducedMotion();

  return (
    <span
      data-testid="streaming-cursor"
      data-breathing="true"
      className="ml-0.5 inline-flex items-center gap-1 align-middle"
      aria-hidden="true"
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-[var(--eco-accent)]"
          animate={shouldReduce ? {} : { scale: [1, 1.4, 1] }}
          transition={{
            duration: 1.2,
            repeat: Infinity,
            delay: i * 0.15,
            ease: "easeInOut",
          }}
        />
      ))}
      <span className="sr-only">Thinking...</span>
    </span>
  );
}

/** Blinking cursor bar for generating state — Motion v12 opacity pulse. */
function GeneratingCursor() {
  const shouldReduce = useReducedMotion();

  return (
    <span
      data-testid="streaming-cursor"
      data-generating="true"
      className="ml-0.5 inline-flex items-center align-middle"
      aria-hidden="true"
    >
      <motion.span
        className="inline-block h-4 w-[3px] rounded-sm bg-[var(--eco-accent)]"
        animate={shouldReduce ? {} : { opacity: [1, 0.4, 1] }}
        transition={{
          duration: 1.2,
          repeat: Infinity,
        }}
      />
      <span className="sr-only">Generating...</span>
    </span>
  );
}

/**
 * Growing seedling SVG icon for the tool-executing and looking-up states.
 * A simple stem with two small leaves, colored with var(--eco-accent).
 * Uses Motion v12 gentle scale pulse. `srLabel` names what is running for screen
 * readers — the generic on-device tools keep "Running tool...", while a web lookup
 * announces the web honestly.
 */
function ToolSeedling({ srLabel = "Running tool..." }: { srLabel?: string }) {
  const shouldReduce = useReducedMotion();

  return (
    <span
      data-testid="streaming-cursor"
      data-tool-executing="true"
      className="ml-0.5 inline-flex items-center align-middle"
    >
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        width="16"
        height="16"
        aria-hidden="true"
        style={{ color: "var(--eco-accent)" }}
        animate={shouldReduce ? {} : { scale: [1, 1.15, 1] }}
        transition={{
          duration: 1.5,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      >
        {/* Stem */}
        <path
          d="M8 14V6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        {/* Left leaf */}
        <path
          d="M8 9C6 9 4.5 7.5 4.5 5.5C6.5 5.5 8 7 8 9Z"
          fill="currentColor"
          opacity="0.85"
        />
        {/* Right leaf */}
        <path
          d="M8 6.5C10 6.5 11.5 5 11.5 3C9.5 3 8 4.5 8 6.5Z"
          fill="currentColor"
          opacity="0.85"
        />
      </motion.svg>
      <span className="sr-only">{srLabel}</span>
    </span>
  );
}

export function StreamingCursor({ phase = "generating" }: StreamingCursorProps) {
  switch (phase) {
    case "idle":
      return null;
    case "loading":
      return <LoadingCursor />;
    case "queued":
    case "thinking":
      return <ThinkingDots />;
    case "generating":
      return <GeneratingCursor />;
    case "tool-executing":
      return <ToolSeedling />;
    case "looking-up":
      return <ToolSeedling srLabel="Looking this up on the web" />;
  }
}
