// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useChatStore } from "../../stores/chatStore";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { BottomSheet } from "../ui/BottomSheet";
import { getCatalog } from "../../local-ai/catalog/catalog";
import { getDisplayInfo } from "../../local-ai/display";
import { canServe, listCatalog, recommend } from "../../local-ai/index";
import { useDeviceProfile } from "../../hooks/local-ai/useDeviceProfile";
import { getSlotForModel } from "../../local-ai/lifecycle/slots";
import { isLocalAiSlot } from "../../local-ai/util";
import type { ModelConfig } from "../../local-ai/types";

type DropdownPosition = {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
  transformOrigin: "top right" | "bottom right";
};

type ModelSelectorProps = {
  variant?: "header" | "composer";
};

/**
 * Composer model selector.
 *
 * Lists the AIs this device can actually run — sourced from `listCatalog`, the
 * same capability-filtered source the Settings → "Switch your AI" dialog uses
 * (via useSwitchAI) — and lets the user pick the active model from the composer
 * without leaving the conversation. Models that can't run on this device (e.g.
 * an f16 build on an adapter without shader-f16) are never offered, so the user
 * can't pick an AI that will fail to load. Selecting a row binds it via the
 * chatStore's `setSelectedModel`.
 *
 * The recommended entry carries a quiet "Recommended" tag. There is no network
 * fetch and no remote-compute option — every choice runs on-device.
 */
export function ModelSelector({ variant = "header" }: ModelSelectorProps) {
  const selectedModel = useChatStore((s) => s.selectedModel);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  const [open, setOpen] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const isComposer = variant === "composer";

  // Reactive device profile: recomputes the instant the async adapter probe
  // resolves (shader-f16 / working-adapter verdict), so the recommendation and
  // the runnable list below converge to the truth without an unrelated
  // re-render — instead of being frozen at the optimistic pre-probe guess.
  const profile = useDeviceProfile();

  // The recommendation depends on the device profile.
  const recommendedId = useMemo(() => {
    if (!canServe(profile)) return null;
    try {
      return recommend("eco-fast", profile).id;
    } catch {
      return null;
    }
  }, [profile]);

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
    const below = window.innerHeight - rect.bottom - margin;
    const above = rect.top - margin;

    if (below < 220 && above > below) {
      setDropdownPosition({
        left,
        bottom: Math.max(margin, window.innerHeight - rect.top + 8),
        width,
        maxHeight: Math.max(160, above - 8),
        transformOrigin: "bottom right",
      });
      return;
    }

    const top = Math.min(rect.bottom + 8, window.innerHeight - margin);
    setDropdownPosition({
      left,
      top,
      width,
      maxHeight: Math.max(160, window.innerHeight - top - margin),
      transformOrigin: "top right",
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
  // concrete catalog model id so the right row highlights.
  const resolvedSelectedId = useMemo(() => {
    if (!hasMounted) return null;
    if (selectedModel === "auto") return recommendedId;
    if (isLocalAiSlot(selectedModel)) {
      // Slot name — resolve to its bound model if any, else the recommendation.
      return getSlotForModelId(selectedModel) ?? recommendedId;
    }
    return selectedModel;
  }, [hasMounted, selectedModel, recommendedId]);

  // Only the AIs this device can actually run — never offer a model that would
  // fail to load (e.g. an f16 build on an adapter without shader-f16). Same
  // capability-filtered source as the Settings "Switch your AI" dialog
  // (useSwitchAI → listCatalog), so the two surfaces stay consistent. The
  // currently-selected model is exempted so it always stays visible. Device
  // probing is client-only, so before mount we render the full catalog to keep
  // the first paint stable, then narrow to the runnable set once mounted.
  const models = useMemo(() => {
    if (!hasMounted) return getCatalog();
    try {
      if (!canServe(profile)) return [];
      const { available } = listCatalog(profile, {
        currentlyBoundModelId: resolvedSelectedId,
      });
      return available.map((entry) => entry.model);
    } catch {
      return getCatalog();
    }
  }, [hasMounted, resolvedSelectedId, profile]);

  const currentModel = models.find((m) => m.id === resolvedSelectedId) ?? null;
  const displayName = hasMounted && currentModel
    ? getDisplayInfo(currentModel.id, currentModel).friendlyName
    : "Choose AI";

  const handleSelect = useCallback(
    (model: ModelConfig) => {
      setSelectedModel(model.id, { explicit: true });
      setOpen(false);
    },
    [setSelectedModel],
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

      {models.map((model) => {
        const display = getDisplayInfo(model.id, model);
        const isSelected = resolvedSelectedId === model.id;
        const isRecommended = recommendedId === model.id;
        return (
          <button
            key={model.id}
            type="button"
            role="option"
            aria-selected={isSelected}
            onClick={() => handleSelect(model)}
            className={`my-0.5 flex min-h-12 w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors ${
              isSelected
                ? "bg-[var(--eco-primary-soft)] text-[var(--eco-primary)]"
                : "text-[var(--eco-text)] hover:bg-[var(--eco-surface-elevated)]"
            }`}
          >
            <div className="flex-1 min-w-0 [overflow-wrap:anywhere]">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{display.friendlyName}</span>
                {isRecommended && (
                  <span className="inline-flex items-center rounded-full bg-[var(--eco-primary-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--eco-primary)]">
                    Recommended
                  </span>
                )}
              </div>
              {display.qualityPhrase && (
                <div className="truncate text-xs text-[var(--eco-text-secondary)]">
                  {display.qualityPhrase}
                </div>
              )}
            </div>
            {isSelected && (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 16 16"
                fill="none"
                className="h-4 w-4 flex-shrink-0 text-[var(--eco-primary)]"
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
          </button>
        );
      })}
    </div>
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className={`flex min-h-[44px] items-center gap-1.5 border text-xs font-medium text-[var(--eco-text-secondary)] transition-colors hover:text-[var(--eco-text)] sm:max-w-[12rem] md:min-h-0 ${
          isComposer
            ? "max-w-[7.5rem] rounded-full border-[var(--eco-border)]/80 bg-[var(--eco-surface)]/70 px-2.5 py-2 hover:bg-[var(--eco-primary-soft)]/35 sm:max-w-[9rem]"
            : "max-w-[8.5rem] rounded-md border-[var(--eco-border)] px-2.5 py-1.5 hover:bg-[var(--eco-surface-elevated)]"
        }`}
        data-testid="model-selector"
        data-tour-target="model-selector"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Select model, ${displayName}`}
      >
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-[var(--eco-primary)] shadow-[0_0_0_3px_color-mix(in_srgb,currentColor,transparent_86%)]"
          aria-hidden="true"
        />
        <span
          className={`min-w-0 truncate ${isComposer ? "hidden sm:inline" : ""}`}
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
            top: dropdownPosition.top,
            bottom: dropdownPosition.bottom,
            width: dropdownPosition.width,
            maxHeight: dropdownPosition.maxHeight,
            transformOrigin: dropdownPosition.transformOrigin,
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
 * Resolve a slot name to the concrete catalog model id bound to it, if any.
 * The composer lists concrete models, so a slot-shaped store selection maps
 * to its bound model for highlighting.
 */
function getSlotForModelId(slot: string): string | null {
  // getSlotForModel maps a model id → slot; we need the inverse, so walk the
  // catalog and ask which slot owns each id until we find a match.
  for (const model of getCatalog()) {
    if (getSlotForModel(model.id) === slot) return model.id;
  }
  return null;
}
