// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { EcoLogo } from "../EcoLogo";
import { resolvePublicAppDestination } from "../../lib/access-policy";

const exploreLinks = [
  { href: "/impact", label: "Impact" },
  { href: "/transparency", label: "Transparency" },
];

const legalLinks = [
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms of Service" },
];

export function PublicFooter() {
  const searchParams = useSearchParams();
  const chatHref = resolvePublicAppDestination(searchParams.get("returnTo"));

  return (
    <footer className="border-t border-[var(--eco-border)] bg-[var(--eco-surface)]">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-12 sm:grid-cols-2 sm:px-6 lg:grid-cols-[1.4fr_1fr_1fr] lg:px-10">
        <div className="space-y-4">
          <EcoLogo size="md" />
          <p className="max-w-sm text-sm leading-6 text-[var(--eco-text-secondary)]">
            A private AI that runs right in your browser. Your conversations
            stay on your device. More is on the way.
          </p>
        </div>

        <div>
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--eco-text-muted)]">
            Explore
          </h2>
          <ul className="mt-4 space-y-3">
            <li>
              <Link
                href={chatHref}
                className="inline-flex min-h-11 min-w-11 items-center text-sm text-[var(--eco-text)] transition-colors hover:text-[var(--eco-primary)]"
              >
                Chat
              </Link>
            </li>
            {exploreLinks.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="inline-flex min-h-11 min-w-11 items-center text-sm text-[var(--eco-text)] transition-colors hover:text-[var(--eco-primary)]"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--eco-text-muted)]">
            Legal
          </h2>
          <ul className="mt-4 space-y-3">
            {legalLinks.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="inline-flex min-h-11 min-w-11 items-center text-sm text-[var(--eco-text)] transition-colors hover:text-[var(--eco-primary)]"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}
