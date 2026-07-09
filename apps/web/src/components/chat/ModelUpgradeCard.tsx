// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

/**
 * ModelUpgradeCard — the consent-driven upgrade surfaces (instant-start 2b).
 *
 * One quiet floating card, bottom-right above the help button, that walks the
 * the growth-stage motif with the upgrade machine — the glyph encodes
 * the machine's real state, not decoration:
 *
 *   offer       → sprout   ("a stronger AI is available — want it?")
 *   downloading → seedling (growing in the background; chat never pauses)
 *   ready       → sapling  ("switch now?" — asked, never imposed)
 *   swapping    → sapling  (brief "one moment")
 *   boosted     → a bottom-center pill: "Eco just got a boost"
 *   deferred    → an honest, dismissible note; no terminal screens
 *
 * Non-modal by design: the whole slice exists so nothing ever blocks chat.
 * Spring entrances, instant under prefers-reduced-motion.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Button,
  SaplingIllustration,
  SeedlingIllustration,
  SproutIllustration,
} from "@eco/ui";
import type { ModelConfig } from "../../local-ai/types";
import type {
  ModelUpgradeUi,
  UseModelUpgradeReturn,
} from "../../hooks/local-ai/useModelUpgrade";

export type ModelUpgradeCardProps = {
  upgrade: UseModelUpgradeReturn;
  /** Streaming disables the swap action — never mid-generation. */
  isStreaming: boolean;
};

const CARD_SPRING = { type: "spring", stiffness: 320, damping: 28 } as const;
/** How long the boost pill lingers before dismissing itself. */
const BOOST_NOTE_MS = 6_000;

function downloadSizeCopy(model: ModelConfig): string {
  const gb = model.sizeGB;
  return gb >= 1 ? `${gb.toFixed(1).replace(/\.0$/, "")} GB` : `${Math.round(gb * 1000)} MB`;
}

/** Percent arrives as a 0..1 fraction from the progress tracker. */
function toDisplayPercent(fraction: number): number {
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

export function ModelUpgradeCard({ upgrade, isStreaming }: ModelUpgradeCardProps) {
  const { ui } = upgrade;
  // Portal to <body>: the chat shell has transformed/filtered ancestors
  // (page transitions, grain layers) that would turn position:fixed into
  // container-relative and strand the card off-position.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  if (ui.kind === "boosted") {
    return createPortal(
      <BoostNote target={ui.target} onDismiss={upgrade.dismiss} />,
      document.body,
    );
  }

  return createPortal(
    <FloatingCardShell visible={ui.kind !== "hidden"} ui={ui}>
      {ui.kind === "offer" && (
        <CardBody
          glyph={<SproutIllustration size={46} className="text-[var(--eco-primary)]" />}
          title="A stronger AI for this device"
          body={`${ui.target.friendlyName} runs well on your hardware. Eco can bring it in quietly while you chat — about ${downloadSizeCopy(ui.target)}, stored on your device.`}
        >
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={upgrade.accept}>
              Download in background
            </Button>
            <Button size="sm" variant="ghost" onClick={upgrade.decline}>
              Not now
            </Button>
          </div>
        </CardBody>
      )}

      {ui.kind === "downloading" && (
        <CardBody
          glyph={<SeedlingIllustration size={46} className="text-[var(--eco-primary)]" />}
          title="Growing your stronger AI"
          body="You can keep chatting — nothing pauses."
        >
          <DownloadProgress percent={toDisplayPercent(ui.percent)} />
        </CardBody>
      )}

      {ui.kind === "ready" && (
        <CardBody
          glyph={<SaplingIllustration size={46} className="text-[var(--eco-primary)]" />}
          title="Your stronger AI is ready"
          body="Switching takes a few seconds, and your conversation stays put."
        >
          {ui.notice && (
            <p
              className="mt-2 text-xs leading-relaxed"
              style={{ color: "var(--eco-text-secondary)" }}
              role="status"
            >
              {ui.notice}
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <Button
              size="sm"
              onClick={upgrade.swapNow}
              disabled={isStreaming}
              title={isStreaming ? "Eco will switch after this reply finishes" : undefined}
            >
              Switch now
            </Button>
            <Button size="sm" variant="ghost" onClick={upgrade.notNow}>
              Later
            </Button>
          </div>
          <p className="mt-2 text-[11px]" style={{ color: "var(--eco-text-muted)" }}>
            Later works too — Eco starts on it next time you open.
          </p>
        </CardBody>
      )}

      {ui.kind === "swapping" && (
        <CardBody
          glyph={<SaplingIllustration size={46} className="text-[var(--eco-primary)]" />}
          title={ui.atBoot ? "Waking up your stronger AI" : "Switching — one moment"}
          body="Your conversation stays put."
        />
      )}

      {ui.kind === "deferred" && (
        <CardBody
          glyph={<SproutIllustration size={46} className="text-[var(--eco-text-secondary)]" />}
          title="Sticking with your current AI"
          body={ui.deferral.message}
        >
          <div className="mt-3">
            <Button size="sm" variant="ghost" onClick={upgrade.dismiss}>
              Okay
            </Button>
          </div>
        </CardBody>
      )}
    </FloatingCardShell>,
    document.body,
  );
}

// ─── Shell + shared pieces ──────────────────────────────────────────────────

function FloatingCardShell({
  visible,
  ui,
  children,
}: {
  visible: boolean;
  ui: ModelUpgradeUi;
  children: React.ReactNode;
}) {
  const reducedMotion = useReducedMotion();

  return (
    <AnimatePresence>
      {visible && (
        <motion.section
          key="model-upgrade-card"
          data-testid="model-upgrade-card"
          data-upgrade-state={ui.kind}
          aria-label="Model upgrade"
          aria-live="polite"
          initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: -14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.98 }}
          transition={reducedMotion ? { duration: 0 } : CARD_SPRING}
          // Top-right, below the chat header. Bottom-anchored positions can
          // ALWAYS overlap the Send button somewhere (the empty state centers
          // the composer, so on ~1280px windows a bottom-right card intercepts
          // clicks — caught by the launch e2e). A consent card that blocks
          // sending would betray the whole slice; top-right never can.
          className="fixed right-4 top-[72px] z-40 w-[calc(100vw-2rem)] max-w-[340px] rounded-2xl border shadow-lg sm:w-[340px] md:right-6 md:top-20"
          style={{
            backgroundColor: "var(--eco-surface-elevated)",
            borderColor: "var(--eco-border)",
          }}
        >
          {/* Grain lives on an inner wrapper: .grain-subtle sets
              position:relative (for its ::after overlay), which would
              override the shell's `fixed` in the cascade and strand the
              card in normal flow — the bug the real-browser journeys caught. */}
          <div className="grain-subtle rounded-[inherit] p-4">{children}</div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

function CardBody({
  glyph,
  title,
  body,
  children,
}: {
  glyph: React.ReactNode;
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span aria-hidden="true" className="mt-0.5 shrink-0">
        {glyph}
      </span>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold" style={{ color: "var(--eco-text)" }}>
          {title}
        </h3>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--eco-text-secondary)" }}>
          {body}
        </p>
        {children}
      </div>
    </div>
  );
}

function DownloadProgress({ percent }: { percent: number }) {
  const reducedMotion = useReducedMotion();
  return (
    <div className="mt-3" aria-hidden={false}>
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Download progress"
        className="h-1.5 w-full overflow-hidden rounded-full"
        style={{ backgroundColor: "var(--eco-primary-soft)" }}
      >
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: "var(--eco-primary)" }}
          initial={false}
          animate={{ width: `${percent}%` }}
          transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 120, damping: 26 }}
        />
      </div>
      <p className="mt-1.5 text-[11px] tabular-nums" style={{ color: "var(--eco-text-muted)" }}>
        {percent}%
      </p>
    </div>
  );
}

/**
 * The post-swap note. Bottom-center pill, auto-dismisses — a status update,
 * never a dialog. Replaces the legacy (unmounted) UpgradedToast.
 */
function BoostNote({ target, onDismiss }: { target: ModelConfig; onDismiss: () => void }) {
  const reducedMotion = useReducedMotion();
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    const timer = setTimeout(() => dismissRef.current(), BOOST_NOTE_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <motion.div
      role="status"
      aria-live="polite"
      data-testid="model-upgrade-boost-note"
      initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reducedMotion ? { duration: 0 } : CARD_SPRING}
      className="pointer-events-none fixed bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-full border px-5 py-2.5 shadow-md backdrop-blur-sm"
      style={{
        backgroundColor: "color-mix(in srgb, var(--eco-surface-elevated) 92%, transparent)",
        borderColor: "color-mix(in srgb, var(--eco-primary) 22%, var(--eco-border))",
      }}
    >
      <span className="flex items-center gap-2.5 whitespace-nowrap text-sm">
        <SaplingIllustration size={18} className="shrink-0 text-[var(--eco-primary)]" />
        <span className="font-medium" style={{ color: "var(--eco-text)" }}>
          Eco just got a boost
        </span>
        <span style={{ color: "var(--eco-text-secondary)" }}>
          — now running {target.friendlyName}
        </span>
      </span>
    </motion.div>
  );
}
