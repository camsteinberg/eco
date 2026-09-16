// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { safeStorage } from "../../lib/local-storage";

const COOKIE_KEY = "eco-cookie-consent-dismissed";

/** Surfaces reserve scroll room below the document while the notice shows (globals.css). */
const PAGE_RESERVE_CLASS = "eco-page-cookie-notice";

/**
 * The chat surface is bottom-anchored end to end — composer, download screen,
 * welcome card, trust footer — so a fixed notice pinned to the bottom lands on
 * whatever is there at some viewport (measured at 1000×740: over both model
 * tiles and the "Start with …" button). Rather than lift each of them out of
 * the way, the notice simply does not render on chat.
 */
function isChatPath(pathname: string): boolean {
  return pathname === "/chat" || pathname.startsWith("/chat/");
}

export function CookieBanner() {
  const [visible, setVisible] = useState(false);
  // Read from the router, not window.location: this component is mounted once
  // in the root layout and never remounts, so a client-side navigation between
  // "/" and "/chat" has to move it.
  const pathname = usePathname();
  const onChat = isChatPath(pathname);
  // Mobile: compact slim bar anchored to the very bottom. sm+: bottom-right card.
  const className =
    "fixed bottom-2 left-2 right-2 z-50 mx-auto max-w-lg rounded-2xl border px-3 py-2 shadow-lg backdrop-blur-md motion-safe:animate-[slideUp_300ms_ease-out] sm:bottom-4 sm:left-4 sm:right-4 sm:px-5 sm:py-3.5 sm:left-auto sm:right-6 sm:bottom-6";

  useEffect(() => {
    // safeStorage never throws — returns null on SSR or storage error.
    const dismissed = safeStorage.get(COOKIE_KEY);
    if (dismissed !== "true") {
      setVisible(true);
    }
  }, []);

  // While the notice is showing, flag <html> so the page reserves scroll room
  // below the document (globals.css) — otherwise this fixed banner sits over
  // the last lines of a policy or article. Cleared on dismiss, on navigation
  // onto the chat surface, and on unmount.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle(PAGE_RESERVE_CLASS, visible && !onChat);
    return () => {
      root.classList.remove(PAGE_RESERVE_CLASS);
    };
  }, [visible, onChat]);

  if (onChat || !visible) return null;

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
