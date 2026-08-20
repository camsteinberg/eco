// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

/**
 * ModelUpgradeCard — the consent-driven upgrade surfaces (instant-start 2b).
 *
 * One quiet card — floating top-right on roomy screens, in the document flow
 * above the greeting on narrow ones — that walks the growth-stage motif with
 * the upgrade machine. The glyph encodes the machine's real state, not
 * decoration:
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
import { ProgressBar } from "../ui/ProgressBar";
import type { ModelConfig } from "../../local-ai/types";
import { useMediaQuery } from "../../hooks/useMediaQuery";
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
  // Below `sm` a 340px card covers the entire column — measured: it erased the
  // greeting and clipped the suggestion tiles. There is no floating position
  // that fits, so the card stops floating: it renders where ChatSurface placed
  // it (in flow, above the greeting/transcript) and pushes content down.
  const inFlow = useMediaQuery("(max-width: 639px)");
  if (!mounted) return null;

  if (ui.kind === "boosted") {
    return createPortal(
      <BoostNote target={ui.target} onDismiss={upgrade.dismiss} />,
      document.body,
    );
  }

  const card = (
    <FloatingCardShell visible={ui.kind !== "hidden"} ui={ui} inFlow={inFlow}>
      {ui.kind === "offer" && (
        <CardBody
          glyph={<SproutIllustration size={46} className="text-[var(--eco-primary)]" />}
          title="A stronger AI for this device"
          titleHint={ui.target.friendlyName}
          body={`Eco can bring it in quietly while you chat — about ${downloadSizeCopy(ui.target)}, stored on your device.`}
        >
          {/* Side by side these two labels need ~266px against the ~249px the
              card has, so both wrapped mid-phrase ("Download in / background",
              "Not / now"), and nowrap alone would overflow instead. Stacking
              fits whatever length the copy takes; the ready card's shorter pair
              still sits on one line. */}
          <div className="mt-3 flex flex-col items-stretch gap-2">
            <Button size="sm" className="whitespace-nowrap" onClick={upgrade.accept}>
              Download in background
            </Button>
            <Button size="sm" variant="ghost" className="whitespace-nowrap" onClick={upgrade.decline}>
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
              className="whitespace-nowrap"
              onClick={upgrade.swapNow}
              disabled={isStreaming}
              title={isStreaming ? "Eco will switch after this reply finishes" : undefined}
            >
              Switch now
            </Button>
            <Button size="sm" variant="ghost" className="whitespace-nowrap" onClick={upgrade.notNow}>
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
            <Button size="sm" variant="ghost" className="whitespace-nowrap" onClick={upgrade.dismiss}>
              Okay
            </Button>
          </div>
        </CardBody>
      )}
    </FloatingCardShell>
  );

  return inFlow ? card : createPortal(card, document.body);
}

// ─── Shell + shared pieces ──────────────────────────────────────────────────

function FloatingCardShell({
  visible,
  ui,
  inFlow,
  children,
}: {
  visible: boolean;
  ui: ModelUpgradeUi;
  /** Narrow screens: render in the document flow instead of floating. */
  inFlow: boolean;
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
          // Floating: top-right, below the chat header. Bottom-anchored
          // positions can ALWAYS overlap the Send button somewhere (the empty
          // state centers the composer, so on ~1280px windows a bottom-right
          // card intercepts clicks — caught by the launch e2e). A consent card
          // that blocks sending would betray the whole slice; top-right never
          // can. In flow (narrow screens) it floats over nothing at all.
          className={
            inFlow
              ? "relative mb-4 w-full rounded-2xl border shadow-sm"
              : "fixed right-4 top-[72px] z-40 w-[calc(100vw-2rem)] max-w-[340px] rounded-2xl border shadow-lg sm:w-[340px] md:right-6 md:top-20"
          }
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
  titleHint,
  body,
  children,
}: {
  glyph: React.ReactNode;
  title: string;
  /** Branded model name surfaced on hover/SR only — transparency, never chrome. */
  titleHint?: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span aria-hidden="true" className="mt-0.5 shrink-0">
        {glyph}
      </span>
      <div className="min-w-0">
        <h3
          className="text-sm font-semibold"
          style={{ color: "var(--eco-text)" }}
          title={titleHint}
        >
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
  return (
    <div className="mt-3">
      <ProgressBar percent={percent} label={`${percent}%`} ariaLabel="Download progress" />
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
