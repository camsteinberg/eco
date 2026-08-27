// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useState, useEffect } from "react";
import { safeStorage } from "../../lib/local-storage";

const COOKIE_KEY = "eco-cookie-consent-dismissed";

/** Chat surfaces reserve space above their bottom-anchored content (globals.css). */
const CHAT_RESERVE_CLASS = "eco-chat-cookie-notice";
/** Every other surface reserves scroll room below the document (globals.css). */
const PAGE_RESERVE_CLASS = "eco-page-cookie-notice";

export function CookieBanner() {
  const [visible, setVisible] = useState(false);
  const pathname = typeof window === "undefined" ? "" : window.location.pathname;
  const isChatSurface = pathname === "/chat" || pathname.startsWith("/chat/");
  // Mobile: compact slim bar anchored to the very bottom (no big lift).
  // Desktop: keep the elevated bottom-right card on chat surfaces; bottom card
  // on marketing surfaces. `lg:right-[4.75rem]` on the chat card keeps it out of
  // the 68px lane at the right edge that the chat surface's floating help button
  // owns — the same offset Toast.tsx uses for the same reason.
  const className = isChatSurface
    ? "fixed bottom-[calc(0.5rem+env(safe-area-inset-bottom))] left-2 right-2 z-50 mx-auto max-w-lg rounded-2xl border px-3 py-2 shadow-lg backdrop-blur-md motion-safe:animate-[slideUp_300ms_ease-out] sm:bottom-[calc(5.5rem+env(safe-area-inset-bottom))] sm:left-4 sm:right-4 sm:px-5 sm:py-3.5 lg:bottom-6 lg:left-auto lg:right-[4.75rem]"
    : "fixed bottom-2 left-2 right-2 z-50 mx-auto max-w-lg rounded-2xl border px-3 py-2 shadow-lg backdrop-blur-md motion-safe:animate-[slideUp_300ms_ease-out] sm:bottom-4 sm:left-4 sm:right-4 sm:px-5 sm:py-3.5 sm:left-auto sm:right-6 sm:bottom-6";

  useEffect(() => {
    // safeStorage never throws — returns null on SSR or storage error.
    const dismissed = safeStorage.get(COOKIE_KEY);
    if (dismissed !== "true") {
      setVisible(true);
    }
  }, []);

  // While the notice is showing, flag <html> so the surface underneath reserves
  // room for it (globals.css) — otherwise this fixed banner sits over whatever
  // is at the bottom of the page. Chat surfaces lift their bottom-anchored
  // chrome; every other page reserves scroll room below the document, so the
  // last lines of a policy or article can be read out from under the notice.
  // Cleared on dismiss, on navigation between the two kinds of surface, and on
  // unmount.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle(CHAT_RESERVE_CLASS, visible && isChatSurface);
    root.classList.toggle(PAGE_RESERVE_CLASS, visible && !isChatSurface);
    return () => {
      root.classList.remove(CHAT_RESERVE_CLASS);
      root.classList.remove(PAGE_RESERVE_CLASS);
    };
  }, [visible, isChatSurface]);

  if (!visible) return null;

  const handleDismiss = () => {
    safeStorage.set(COOKIE_KEY, "true");
    setVisible(false);
  };

  return (
    <div
      data-eco-cookie-notice
      role="status"
      aria-live="polite"
      className={className}
      style={{
        backgroundColor: "color-mix(in srgb, var(--eco-surface-elevated) 85%, transparent)",
        borderColor: "var(--eco-border)",
      }}
    >
      <div className="flex items-center gap-2 sm:gap-4">
        {/* Leaf icon — hidden on very narrow widths to keep banner compact */}
        <svg width="16" height="16" viewBox="0 0 32 32" fill="none" className="hidden shrink-0 sm:block" aria-hidden="true">
          <path d="M7 25C7 25 5.5 16 11 11C16.5 6 25 4.5 28 4.5C28 4.5 29.5 13.5 24 19C18.5 24.5 10 25 7 25Z" fill="var(--eco-primary)" opacity="0.6" />
        </svg>

        <p className="text-xs leading-snug sm:text-sm" style={{ color: "var(--eco-text-secondary)" }}>
          Only essential cookies and local browser preferences. No tracking.{" "}
          <a
            href="/privacy"
            className="inline underline underline-offset-2 transition-colors hover:text-[var(--eco-text)]"
            style={{ color: "var(--eco-primary)" }}
          >
            Learn more
          </a>
        </p>

        <button
          type="button"
          onClick={handleDismiss}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--eco-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--eco-surface-elevated)]"
          style={{ color: "var(--eco-text-secondary)" }}
          aria-label="Dismiss cookie notice"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M4 4L12 12M12 4L4 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
