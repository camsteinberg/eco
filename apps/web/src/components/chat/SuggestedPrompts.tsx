// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { motion, useReducedMotion } from "motion/react"
import { springPresets } from "@eco/ui"

type SuggestedPromptsProps = {
  onSelect?: (prompt: string) => void
}

// Grid orchestrates a gentle spring stagger; each tile rises into place.
// delayChildren lets the greeting settle first so the empty state reads top-down.
const gridVariants = {
  hidden: {},
  show: { transition: { delayChildren: 0.08, staggerChildren: 0.06 } },
} as const

const tileVariants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: springPresets.gentle },
} as const

function LightbulbIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-5 w-5"
      style={{ color: "var(--eco-primary)", opacity: 0.6 }}
      aria-hidden="true"
    >
      <path d="M10 1a6 6 0 00-3.815 10.631C6.88 12.32 7.25 13.46 7.25 14.5v.055c0 .26.105.509.292.693l.344.344a.25.25 0 00.177.073h3.874a.25.25 0 00.177-.073l.344-.344a.981.981 0 00.292-.693V14.5c0-1.04.37-2.18 1.065-2.869A6 6 0 0010 1zM8.25 17a.75.75 0 000 1.5h3.5a.75.75 0 000-1.5h-3.5z" />
    </svg>
  )
}

function PlanIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-5 w-5"
      style={{ color: "var(--eco-primary)", opacity: 0.6 }}
      aria-hidden="true"
    >
      <path d="M6.5 3.5A2.5 2.5 0 004 6c0 1.52 1.4 2.88 2.83 4.09.32.27.82.27 1.14 0C9.4 8.88 10.8 7.52 10.8 6a2.5 2.5 0 00-4.3-1.74A2.5 2.5 0 006.5 3.5z" />
      <path d="M13.5 8a2.5 2.5 0 00-2.5 2.5c0 1.52 1.4 2.88 2.83 4.09.32.27.82.27 1.14 0 1.43-1.21 2.83-2.57 2.83-4.09A2.5 2.5 0 0013.5 8zM3.5 14.25a.75.75 0 000 1.5h4.25a.75.75 0 000-1.5H3.5z" />
    </svg>
  )
}

function AnalyzeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-5 w-5"
      style={{ color: "var(--eco-primary)", opacity: 0.6 }}
      aria-hidden="true"
    >
      <path d="M4.5 2A1.5 1.5 0 003 3.5v13A1.5 1.5 0 004.5 18h11a1.5 1.5 0 001.5-1.5V7.621a1.5 1.5 0 00-.44-1.06l-4.12-4.122A1.5 1.5 0 0011.378 2H4.5zm2.25 8.5a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5zm0 3a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z" />
    </svg>
  )
}

function QuillIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-5 w-5"
      style={{ color: "var(--eco-primary)", opacity: 0.6 }}
      aria-hidden="true"
    >
      <path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
    </svg>
  )
}

const tiles = [
  {
    title: "Understand something",
    description: "Explain something confusing in plain English",
    icon: LightbulbIcon,
  },
  {
    title: "Plan something",
    description: "Help me plan a calm, realistic week",
    icon: PlanIcon,
  },
  {
    title: "Analyze a file",
    description: "Summarize a document I'll upload",
    icon: AnalyzeIcon,
  },
  {
    title: "Write clearly",
    description: "Draft a kind reply to a stressful message",
    icon: QuillIcon,
  },
] as const

export function SuggestedPrompts({ onSelect }: SuggestedPromptsProps) {
  const shouldReduceMotion = useReducedMotion()
  return (
    <div className="w-full max-w-2xl lg:max-w-3xl">
      {/* 2×2 on mobile so the composer stays above the fold; unchanged (2-up) at sm+. */}
      <motion.div
        className="grid w-full grid-cols-2 gap-2.5 sm:gap-3"
        variants={gridVariants}
        initial={shouldReduceMotion ? false : "hidden"}
        animate="show"
      >
        {tiles.map((tile) => {
          const Icon = tile.icon
          return (
            <motion.button
              key={tile.title}
              type="button"
              onClick={() => onSelect?.(tile.description)}
              variants={tileVariants}
              whileHover={shouldReduceMotion ? undefined : { y: -2 }}
              whileTap={shouldReduceMotion ? undefined : { scale: 0.99 }}
              className="group cursor-pointer rounded-2xl border border-l-[3px] border-[var(--eco-border)] border-l-transparent bg-[var(--eco-surface-elevated)]/85 p-4 text-left shadow-sm transition-[background-color,border-color,box-shadow] duration-150 hover:border-[var(--eco-primary)] hover:border-l-[var(--eco-primary)] hover:bg-[var(--eco-primary-soft)]/55 hover:shadow-md"
            >
              <div className="mb-2">
                <Icon />
              </div>
              <p className="text-sm font-medium text-[var(--eco-text)]">
                {tile.title}
              </p>
              <p className="mt-1 text-xs text-[var(--eco-text-secondary)]">
                {tile.description}
              </p>
            </motion.button>
          )
        })}
      </motion.div>
    </div>
  )
}
