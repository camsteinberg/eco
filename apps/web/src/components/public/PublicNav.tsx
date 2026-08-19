// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { EcoLogo } from "../EcoLogo";
import { resolvePublicAppDestination } from "../../lib/access-policy";

const publicLinks = [
  { href: "/impact", label: "Impact" },
  { href: "/transparency", label: "Transparency" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
];

export function PublicNav() {
  const searchParams = useSearchParams();
  const appHref = resolvePublicAppDestination(searchParams.get("returnTo"));

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--eco-border)] bg-[color-mix(in_srgb,var(--eco-surface)_92%,transparent)] backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-10">
        <div className="flex items-center justify-between gap-4">
          <Link
            href={appHref}
            aria-label="Go to chat"
            className="inline-flex min-h-11 min-w-11 items-center justify-center"
          >
            <EcoLogo size="md" />
          </Link>

          <nav
            aria-label="Public navigation"
            className="hidden items-center gap-5 text-sm text-[var(--eco-text-secondary)] md:flex"
          >
            {publicLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="inline-flex min-h-11 min-w-11 items-center justify-center transition-colors hover:text-[var(--eco-text)]"
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <Link
            href={appHref}
            className="inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2.5 text-sm font-medium text-[var(--eco-on-primary)] transition-all hover:opacity-95"
            style={{ backgroundColor: "var(--eco-primary)" }}
          >
            Start chatting
          </Link>
        </div>

        <nav
          aria-label="Mobile public navigation"
          className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--eco-text-secondary)] md:hidden"
        >
          {publicLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="inline-flex min-h-11 min-w-11 items-center justify-center transition-colors hover:text-[var(--eco-text)]"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
