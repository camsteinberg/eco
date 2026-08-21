// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useChatStore } from "../../stores/chatStore";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { BottomSheet } from "../ui/BottomSheet";
import { getModel } from "../../local-ai/catalog/catalog";
import { getDisplayInfo } from "../../local-ai/display";
import { canServe } from "../../local-ai/index";
import { useDeviceProfile } from "../../hooks/local-ai/useDeviceProfile";
import { getSlot, getSlotForModel } from "../../local-ai/lifecycle/slots";
import { isModelDownloaded } from "../../local-ai/download/download";
import { deriveFirstRunChoices } from "../../local-ai/selection/first-run-choices";
import { toWelcomeChoice } from "../local-ai/welcome-choices";
import type { WelcomeModelChoice } from "../local-ai/WelcomeCard";
import { isLocalAiSlot } from "../../local-ai/util";
import type { ModelConfig, Slot } from "../../local-ai/types";
import { motion, useReducedMotion } from "motion/react";
import { SaplingIllustration, SeedlingIllustration } from "@eco/ui";
import { useModelUpgradeUi } from "../../hooks/local-ai/useModelUpgrade";

type DropdownPosition = {
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
};

/** One offered AI, with everything the tile needs to be honest about it. */
type PairTile = {
  /** Plain-language card copy — same mapping the first-run welcome card uses. */
  choice: WelcomeModelChoice;
  /** The slot that owns this model, if any. Selection writes THIS, never the id. */
  slot: Slot | null;
  /** Its bytes are present (or its slot is ready), so choosing it costs nothing. */
  downloaded: boolean;
  /** The model currently serving this conversation. */
  isActive: boolean;
  /** Carries the quiet "Recommended" tag (never on a single-tile device). */
  isRecommended: boolean;
};

/**
 * Composer model selector.
 *
 * Offers the DEVICE PAIR — the same honest one-or-two-model offer the first-run
 * welcome card makes (`deriveFirstRunChoices`), presented with the same tile
 * anatomy: plain name, size, tagline, and Speed/Depth meters. Not the full
 * catalog: a composer dropdown is a glance decision, and a flat list of every
 * runnable build asks the user to compare things they can't tell apart. The
 * power-user surface with every model is still one tap away behind
 * "Switch your AI" (Settings → Models), which is where downloads happen.
 *
 * Two rules keep this surface truthful:
 *   - it never hides what is actually running — a serving model outside the pair
 *     is appended as its own tile rather than dropped;
 *   - it never writes a concrete model id. A downloaded, slot-bound tile is
 *     selected by SLOT NAME, so the store can't end up holding an id no slot
 *     owns (which is precisely the state dispatch has to normalize away). A tile
 *     whose bytes aren't here routes to the real download flow instead of
 *     pretending the switch already happened.
 *
 * Its one mount is `ChatInput`'s composer row, pinned to the bottom of the
 * viewport: on a pointer device the panel is portalled and anchored ABOVE the
 * trigger, on a touch layout it is a bottom sheet.
 */
export function ModelSelector() {
  const selectedModel = useChatStore((s) => s.selectedModel);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");

  // Reactive device profile: recomputes the instant the async adapter probe
  // resolves (shader-f16 / working-adapter verdict), so the offer converges to
  // the truth without an unrelated re-render — instead of being frozen at the
  // optimistic pre-probe guess.
  const profile = useDeviceProfile();

  // Read-only reflection of the shared upgrade lifecycle — the composer glyph
  // grows (settled sapling → seedling) while a better model downloads. This
  // NEVER drives the upgrade machine (that single driver lives in
  // useChatPageEffects); it only subscribes to the shared state.
  const upgradeUi = useModelUpgradeUi();
  const isUpgrading = upgradeUi.kind === "downloading";
  const reducedMotion = useReducedMotion();

  // The device's honest offer: one or two models, best-first, with the fast pick
  // recommended. Same domain call the welcome card makes, so the composer and
  // first-run never disagree about what this device should run.
  const offer = useMemo(() => {
    if (!hasMounted || !canServe(profile)) {
      return { models: [] as ModelConfig[], recommendedId: null as string | null };
    }
    try {
      const derived = deriveFirstRunChoices("eco-fast", profile);
      return { models: derived.models, recommendedId: derived.recommendedId };
    } catch {
      // No assignable model for this device — the trigger still renders, the
      // panel is simply empty and points at Settings.
      return { models: [] as ModelConfig[], recommendedId: null as string | null };
    }
  }, [hasMounted, profile]);

  const updateDropdownPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === "undefined") {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const margin = 12;
    const width = Math.min(320, Math.max(256, window.innerWidth - margin * 2));
    const left = Math.min(
      Math.max(rect.right - width, margin),
      Math.max(margin, window.innerWidth - width - margin),
    );
    // The trigger lives in the composer, at the bottom of the window, so the
    // panel always opens upward: it is anchored to the trigger's top edge and
    // grows into the space above it.
    setDropdownPosition({
      left,
      bottom: Math.max(margin, window.innerHeight - rect.top + 8),
      width,
      maxHeight: Math.max(160, rect.top - margin - 8),
    });
  }, []);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    if (!open || isMobile) {
      setDropdownPosition(null);
      return;
    }

    updateDropdownPosition();
    window.addEventListener("resize", updateDropdownPosition);
    window.addEventListener("scroll", updateDropdownPosition, true);
    return () => {
      window.removeEventListener("resize", updateDropdownPosition);
      window.removeEventListener("scroll", updateDropdownPosition, true);
    };
  }, [isMobile, open, updateDropdownPosition]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      const triggerContainsTarget = ref.current?.contains(target) ?? false;
      const dropdownContainsTarget = dropdownRef.current?.contains(target) ?? false;
      if (!triggerContainsTarget && !dropdownContainsTarget) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!open || isMobile) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, open]);

  // Resolve the chat store's selection (slot name or concrete model id) to a
  // concrete catalog model id so the right tile reads as active.
  const resolvedSelectedId = useMemo(() => {
    if (!hasMounted) return null;
    if (selectedModel === "auto") return offer.recommendedId;
    if (isLocalAiSlot(selectedModel)) {
      // Slot name — resolve to its bound model if any, else the recommendation.
      return getSlot(selectedModel).model?.id ?? offer.recommendedId;
    }
    return selectedModel;
  }, [hasMounted, selectedModel, offer.recommendedId]);

  // The offer, plus the serving model when it is not part of it (a model bound
  // before the device profile changed, or an upgrade that outgrew the pair).
  // Never hide what is actually running.
  const models = useMemo(() => {
    const list = [...offer.models];
    if (resolvedSelectedId && !list.some((model) => model.id === resolvedSelectedId)) {
      const running = getModel(resolvedSelectedId);
      if (running) list.push(running);
    }
    return list;
  }, [offer.models, resolvedSelectedId]);

  // Whether each offered model's bytes are actually present. Async (Cache API /
  // OPFS), so it is probed when the panel opens and reported as "not downloaded"
  // until it answers — the honest default, and the one that routes the user to
  // the real download flow rather than to a silent mid-turn fetch.
  const [downloadedIds, setDownloadedIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!open || models.length === 0) return;
    let cancelled = false;
    void (async () => {
      const probes = await Promise.all(
        models.map(async (model) => {
          const present = await isModelDownloaded(model).catch(() => false);
          return [model.id, present] as const;
        }),
      );
      if (cancelled) return;
      setDownloadedIds(new Set(probes.filter(([, present]) => present).map(([id]) => id)));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, models]);

  const tiles = useMemo<PairTile[]>(() => {
    // `open` is a dependency on purpose: slot bindings and readiness live in
    // localStorage, not React state, so the panel re-reads them every time it
    // opens instead of trusting a value captured on mount.
    void open;
    return models.map((model) => {
      const slot = getSlotForModel(model.id);
      const slotReady = slot !== null && getSlot(slot).status === "ready";
      return {
        choice: toWelcomeChoice(model),
        slot,
        downloaded: slotReady || downloadedIds.has(model.id),
        isActive: model.id === resolvedSelectedId,
        // A recommendation among one option is noise, not guidance.
        isRecommended: models.length > 1 && model.id === offer.recommendedId,
      };
    });
  }, [models, downloadedIds, resolvedSelectedId, offer.recommendedId, open]);

  const currentModel = models.find((m) => m.id === resolvedSelectedId) ?? null;
  // One identity in the composer: the model is always "Eco". Its branded name
  // (e.g. "Eco Reasoning") is a hover/screen-reader transparency detail — we
  // never hide what's running, but we don't make the user carry it as chrome.
  const brandedName = hasMounted && currentModel
    ? getDisplayInfo(currentModel.id, currentModel).friendlyName
    : null;
  const displayName = hasMounted && currentModel ? "Eco" : "Choose AI";

  const handleSelect = useCallback(
    (tile: PairTile) => {
      if (tile.isActive) {
        setOpen(false);
        return;
      }
      if (tile.downloaded && tile.slot) {
        // SLOT NAME, never the concrete id: a store selection no slot owns is
        // the exact state that used to let an undownloaded model reach the
        // runtime, which then self-fetched it mid-turn.
        setSelectedModel(tile.slot, { explicit: true });
        setOpen(false);
        return;
      }
      // Bytes aren't here (or nothing owns them): hand off to the verified
      // download flow in Settings, preselected on this model.
      setOpen(false);
      router.push(`/settings?tab=models&switch=${encodeURIComponent(tile.choice.id)}`);
    },
    [router, setSelectedModel],
  );

  const modelList = (
    <div
      role="listbox"
      aria-label="Select model"
      className={isMobile ? "min-w-0 p-2 [overflow-wrap:anywhere]" : "min-w-0 p-1.5 [overflow-wrap:anywhere]"}
    >
      <div className="mb-1 flex items-center justify-between gap-3 px-2.5 py-1.5">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--eco-text-secondary)]">
            Model
          </p>
          <p className="text-xs text-[var(--eco-text-secondary)]">
            Every AI here runs on your device.
          </p>
        </div>
        <a
          href="/settings?tab=models"
          className="inline-flex min-h-8 shrink-0 items-center rounded-md px-1.5 text-xs font-medium text-[var(--eco-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]"
        >
          Switch your AI
        </a>
      </div>

      <div className="flex flex-col gap-2 px-1 pb-1">
        {tiles.map((tile) => (
          <ModelPairTile key={tile.choice.id} tile={tile} onSelect={() => handleSelect(tile)} />
        ))}
      </div>
    </div>
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        // Exactly the class list the composer variant produced — this commit
        // removes an unused variant, it does not restyle the trigger.
        className="flex min-h-[44px] items-center gap-1.5 border text-xs font-medium text-[var(--eco-text-secondary)] transition-colors hover:text-[var(--eco-text)] sm:max-w-[12rem] md:min-h-0 max-w-[7.5rem] rounded-full border-[var(--eco-border)] bg-[var(--eco-surface)]/70 px-2.5 py-2 hover:bg-[var(--eco-primary-soft)]/35 sm:max-w-[9rem]"
        data-testid="model-selector"
        data-tour-target="model-selector"
        aria-expanded={open}
        aria-haspopup="listbox"
        title={brandedName ?? undefined}
        aria-label={brandedName ? `Select model — Eco, running ${brandedName}` : `Select model, ${displayName}`}
      >
        <motion.span
          key={isUpgrading ? "growing" : "settled"}
          className="inline-flex shrink-0 text-[var(--eco-primary)] [&_svg]:stroke-[2.5] sm:[&_svg]:stroke-[1.5]"
          aria-hidden="true"
          initial={reducedMotion ? false : { scale: 0.72, opacity: 0.5 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 26 }}
        >
          {isUpgrading ? (
            <SeedlingIllustration size={15} />
          ) : (
            <SaplingIllustration size={15} />
          )}
        </motion.span>
        <span
          className="min-w-0 truncate hidden sm:inline"
        >
          {displayName}
        </span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          fill="currentColor"
          className="h-3 w-3 shrink-0"
        >
          <path
            fillRule="evenodd"
            d="M4.22 6.22a.75.75 0 011.06 0L8 8.94l2.72-2.72a.75.75 0 111.06 1.06l-3.25 3.25a.75.75 0 01-1.06 0L4.22 7.28a.75.75 0 010-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {/* Mobile: bottom sheet */}
      {isMobile && (
        <BottomSheet
          open={open}
          onClose={() => setOpen(false)}
          title="Select model"
        >
          {modelList}
        </BottomSheet>
      )}

      {/* Desktop: dropdown */}
      {!isMobile && open && hasMounted && dropdownPosition && createPortal(
        <div
          ref={dropdownRef}
          className="eco-grain-subtle fixed z-50 overflow-x-hidden overflow-y-auto rounded-lg border border-[var(--eco-border)] bg-[var(--eco-surface)] shadow-lg"
          style={{
            position: "fixed",
            left: dropdownPosition.left,
            bottom: dropdownPosition.bottom,
            width: dropdownPosition.width,
            maxHeight: dropdownPosition.maxHeight,
            transformOrigin: "bottom right",
          }}
        >
          {modelList}
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * One AI, as a tile — the welcome card's anatomy compacted for a 320px panel:
 * name + size, the quiet Recommended tag, one plain sentence, Speed/Depth
 * meters, and the download state. Deliberately re-stated here rather than
 * imported from `WelcomeCard`: that tile is a full-bleed radio in a modal with
 * its own sizing and selection semantics, and coupling the two would make every
 * first-run tweak a composer regression.
 */
function ModelPairTile({ tile, onSelect }: { tile: PairTile; onSelect: () => void }) {
  const { choice, downloaded, isActive, isRecommended } = tile;
  return (
    <button
      type="button"
      role="option"
      aria-selected={isActive}
      onClick={onSelect}
      className="flex w-full flex-col rounded-xl px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]"
      style={{
        background: isActive ? "var(--eco-primary-soft)" : "var(--eco-surface)",
        border: `1.5px solid ${isActive ? "var(--eco-primary)" : "var(--eco-border)"}`,
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-semibold text-[var(--eco-text)]">
          {choice.name}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--eco-text-muted)]">
          {choice.sizeLabel}
        </span>
      </div>

      {/* In-flow and neutral, like every other "Recommended" tag in the product:
          the primary hue belongs to the active tile alone, so the two never read
          as rival approvals. */}
      {isRecommended && (
        <span
          className="mt-1 inline-flex w-fit items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium"
          style={{
            background: "color-mix(in srgb, var(--eco-text-muted) 14%, transparent)",
            color: "var(--eco-text-secondary)",
          }}
        >
          Recommended
        </span>
      )}

      <p className="mt-1 text-xs leading-snug text-[var(--eco-text-secondary)]">
        {choice.tagline}
      </p>

      <div className="mt-2 flex flex-col gap-1">
        <Meter label="Speed" value={choice.speed} />
        <Meter label="Depth" value={choice.depth} />
      </div>

      {/* The state line. The size sits at the top of the tile; this says only
          whether choosing costs a download — the one fact the old flat list
          never told anyone. */}
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--eco-text-muted)]">
        {downloaded && (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="none"
            className="h-3 w-3 shrink-0 text-[var(--eco-primary)]"
            aria-hidden="true"
          >
            <path
              d="M3.5 8.5l3 3 6-7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        <span>{downloaded ? "Downloaded" : "Not downloaded"}</span>
        {isActive && <span aria-hidden="true">·</span>}
        {isActive && <span className="text-[var(--eco-primary)]">Active</span>}
      </div>
    </button>
  );
}

/** A tiny 4-dot meter with a label — casual, glanceable. */
function Meter({ label, value }: { label: string; value: number }) {
  const v = Math.max(0, Math.min(4, value));
  return (
    <div className="flex items-center gap-2">
      <span className="w-9 text-[10px] text-[var(--eco-text-muted)]">{label}</span>
      <span className="flex gap-1" aria-label={`${label}: ${String(v)} of 4`}>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full"
            style={{
              background:
                i < v
                  ? "var(--eco-primary)"
                  : "color-mix(in srgb, var(--eco-primary) 18%, transparent)",
            }}
          />
        ))}
      </span>
    </div>
  );
}
