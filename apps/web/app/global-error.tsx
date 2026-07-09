// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useEffect } from "react";
import { Fraunces, DM_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { EmptyState } from "../src/components/ui/EmptyState";
import { PineIllustration } from "../src/components/illustrations/PineIllustration";

// global-error replaces the root layout entirely, so it must self-provide the
// same font variables the layout puts on <html>/<body>. Without them, `font-serif`
// falls back to Georgia and body text to system-ui.
const serif = Fraunces({ subsets: ["latin"], variable: "--font-serif", display: "swap" });
const sans = DM_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export default function GlobalError({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  // Dark-mode tokens key off `html.dark`, which the layout's inline
  // theme script normally sets. That script can't run here — global-error
  // replaces the layout and the production CSP (nonce-only + strict-dynamic)
  // would block an un-nonced inline <script>. So resolve the theme after
  // hydration instead; a brief light flash on this catastrophic-failure page
  // is an acceptable trade for staying CSP-clean and dependency-free.
  useEffect(() => {
    try {
      const stored = localStorage.getItem("eco-theme");
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const isDark = stored === "dark" || (stored !== "light" && prefersDark);
      document.documentElement.classList.toggle("dark", isDark);
      document.documentElement.style.colorScheme = isDark ? "dark" : "light";
    } catch {
      // Best-effort: if storage is unavailable we keep the light default.
    }
  }, []);

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${serif.variable} ${sans.variable} ${mono.variable} font-sans`}>
        <div className="flex min-h-dvh items-center justify-center px-4">
          <div className="flex flex-col items-center gap-3">
            <EmptyState
              illustration={<PineIllustration />}
              title="Something tripped us up"
              description="We hit an unexpected snag. Try refreshing, or open browser chat again when you're ready."
              action={{ label: "Try again", onClick: reset }}
            />
            <a
              href="/chat"
              className="inline-flex min-h-11 items-center justify-center rounded-full border border-[var(--eco-border)] px-5 py-2.5 text-sm font-medium text-[var(--eco-text)]"
            >
              Open browser chat
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
