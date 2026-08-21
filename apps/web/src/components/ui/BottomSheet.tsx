// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useEffect, useId, useRef, useCallback, useState } from "react"
import { createPortal } from "react-dom"
import { registerOpenBottomSheet } from "../../lib/bottom-sheet-open"

/**
 * The breakpoint at which the sheet stops being the right affordance and the
 * surface it stands in for takes over.
 */
type BottomSheetHiddenFrom = "md" | "lg"

/**
 * Tailwind only generates the utilities it can see spelled out in source, so
 * both variants are literal strings here — an interpolated `${x}:hidden` would
 * compile to nothing and leave the sheet visible at every width.
 */
const HIDDEN_FROM_CLASS: Record<BottomSheetHiddenFrom, string> = {
  md: "md:hidden",
  lg: "lg:hidden",
}

type BottomSheetProps = {
  open: boolean
  onClose: () => void
  title?: string
  /**
   * Viewport floor above which the sheet is hidden. Defaults to `"md"` (hidden
   * from 768px up); pass `"lg"` when the sheet also has to cover the tablet
   * range, because the surface replacing it only appears at 1024px.
   */
  hiddenFrom?: BottomSheetHiddenFrom
  children: React.ReactNode
}

/**
 * Bottom sheet overlay. Renders a backdrop with a sheet that slides up from the
 * bottom of the viewport, hidden from `hiddenFrom` up (`md` by default).
 *
 * Rendered through a portal on `document.body` so the sheet's z-index is
 * resolved against the page root: inline, any transformed or z-indexed ancestor
 * created a stacking context the sheet could not escape, and lower-z overlays
 * that portal to the body painted over it.
 *
 * Supports swipe-to-dismiss: dragging down > 100px when the sheet's scroll
 * position is at the top dismisses the sheet.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  hiddenFrom = "md",
  children,
}: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const touchStartY = useRef<number>(0)
  const currentTranslateY = useRef<number>(0)
  const swipeActive = useRef<boolean>(false)
  const firstMoveChecked = useRef<boolean>(false)
  // Portals need a DOM: hold the first render (server render and hydration
  // pass) at null, then mount for real on the client.
  const [hasMounted, setHasMounted] = useState(false)

  useEffect(() => {
    setHasMounted(true)
  }, [])

  // Publish "a sheet is covering the bottom of the screen" for the floating
  // chrome that lives there (the help disc). Registered here rather than at the
  // call sites so every sheet says it, and released on close AND unmount so a
  // sheet that disappears with its parent can't leave the signal stuck on.
  useEffect(() => {
    if (!open) return
    return registerOpenBottomSheet()
  }, [open])

  useEffect(() => {
    // `hasMounted` is a dependency, not just a guard: the sheet's DOM does not
    // exist on the render that opens it, so focus has to wait for the portal.
    if (!open || !hasMounted) return

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButtonRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
        return
      }

      if (event.key === "Tab") {
        const sheet = sheetRef.current
        if (!sheet) return

        const focusable = Array.from(
          sheet.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true")

        if (focusable.length === 0) {
          event.preventDefault()
          sheet.focus()
          return
        }

        const first = focusable[0]!
        const last = focusable[focusable.length - 1]!
        const active = document.activeElement

        if (event.shiftKey && active === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && active === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      previouslyFocusedRef.current?.focus()
      previouslyFocusedRef.current = null
    }
  }, [hasMounted, onClose, open])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    if (!touch) return
    touchStartY.current = touch.clientY
    currentTranslateY.current = 0
    swipeActive.current = false
    firstMoveChecked.current = false
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    if (!touch) return
    const dy = touch.clientY - touchStartY.current

    // On first move, check if scroll is at top
    if (!firstMoveChecked.current) {
      firstMoveChecked.current = true
      const scrollTop = bodyRef.current?.scrollTop ?? 0
      if (scrollTop > 0) {
        // Not at top — let normal scroll handle it
        swipeActive.current = false
        return
      }
      swipeActive.current = true
    }

    if (!swipeActive.current) return

    // Only translate downward (dy > 0)
    if (dy > 0) {
      currentTranslateY.current = dy
      if (sheetRef.current) {
        sheetRef.current.style.transform = `translateY(${String(dy)}px)`
        sheetRef.current.style.transition = "none"
      }
    }
  }, [])

  const handleTouchEnd = useCallback(() => {
    if (!swipeActive.current) return

    if (currentTranslateY.current > 100) {
      onClose()
    }

    // Snap back
    if (sheetRef.current) {
      sheetRef.current.style.transform = "translateY(0)"
      sheetRef.current.style.transition = "transform 200ms ease"
    }

    currentTranslateY.current = 0
    swipeActive.current = false
    firstMoveChecked.current = false
  }, [onClose])

  if (!open || !hasMounted) return null

  return createPortal(
    <div className={`fixed inset-0 z-50 overflow-hidden ${HIDDEN_FROM_CLASS[hiddenFrom]}`}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[var(--eco-scrim)]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title ? undefined : "Bottom sheet"}
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className="absolute bottom-0 left-0 right-0 flex max-h-[calc(100dvh_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom)_-_0.75rem)] w-full max-w-full flex-col overflow-hidden overscroll-contain rounded-t-xl border border-[var(--eco-border)]/70 bg-[var(--eco-surface-elevated)] shadow-[0_-24px_80px_rgba(26,26,26,0.18)] motion-reduce:transition-none sm:max-h-[85dvh]"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Drag handle */}
        <div className="flex shrink-0 justify-center pt-3 pb-2">
          <div
            data-testid="drag-handle"
            className="h-1 w-10 rounded-full bg-[var(--eco-border)]"
          />
        </div>

        {/* Title */}
        <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-3 border-b border-[var(--eco-border)] bg-[var(--eco-surface-elevated)]/95 px-4 pb-3 backdrop-blur">
          {title ? (
            <h2
              id={titleId}
              data-testid="sheet-title"
              className="min-w-0 truncate font-serif text-lg font-medium text-[var(--eco-text)]"
            >
              {title}
            </h2>
          ) : (
            <span id={titleId} className="sr-only">Bottom sheet</span>
          )}
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-[var(--eco-text-secondary)] transition-colors hover:bg-[var(--eco-primary-soft)]/45 hover:text-[var(--eco-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)] motion-reduce:transition-none"
            aria-label={title ? `Close ${title}` : "Close bottom sheet"}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div
          ref={bodyRef}
          data-testid="bottom-sheet-body"
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pb-[calc(env(safe-area-inset-bottom)+1rem)]"
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}
