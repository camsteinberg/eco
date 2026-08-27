// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Fraunces, DM_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { SwRegistration } from "../src/components/layout/SwRegistration";
import { CookieBannerWrapper } from "../src/components/ui/CookieBannerWrapper";
import { staticAssetRecoveryScript } from "../src/lib/static-asset-recovery-script";

const serif = Fraunces({
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
});

const sans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Eco — AI that respects you and the planet",
  description:
    "Private AI chat that runs on your device, in your browser. Your conversations never go to a server; an account is optional.",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: "/icons/icon-192x192.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // `cover` lets the page paint under the notch/home-indicator; components then
  // reclaim safe space via env(safe-area-inset-*). `resizes-content` reflows the
  // layout (so h-dvh shrinks) when the soft keyboard opens, keeping the composer
  // above it without JS.
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  // Match --eco-surface so the mobile browser chrome blends with the page.
  // A Viewport export needs literal strings; keep these in sync with
  // packages/ui/src/tokens/tokens.css (--eco-surface light / dark).
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f0e8" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1a" },
  ],
};

const themeScript = `
(function() {
  try {
    var stored = localStorage.getItem('eco-theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var resolved = stored === 'dark' ? 'dark' :
      stored === 'light' ? 'light' :
      prefersDark ? 'dark' : 'light';
    var isDark = resolved === 'dark';
    if (isDark) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
    document.documentElement.style.colorScheme = resolved;
    var fontSize = localStorage.getItem('eco-font-size');
    if (fontSize) document.documentElement.dataset.fontSize = fontSize.toLowerCase();
  } catch (e) {}
})();
`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: staticAssetRecoveryScript }} />
      </head>
      <body className={`${serif.variable} ${sans.variable} ${mono.variable} font-sans`}>
        <noscript>
          <style>{`.scroll-reveal, .stagger > * { opacity: 1 !important; transform: none !important; animation: none !important; }`}</style>
        </noscript>
        {children}
        <SwRegistration />
        <CookieBannerWrapper />
      </body>
    </html>
  );
}
