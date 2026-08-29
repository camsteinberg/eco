// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { Metadata } from "next";
import Link from "next/link";
import { use } from "react";
import { EcoLogo } from "../../src/components/EcoLogo";
import { PublicFooter } from "../../src/components/public/PublicFooter";
import { PublicNav } from "../../src/components/public/PublicNav";
import { resolvePublicAppDestination } from "../../src/lib/access-policy";
import { resolveReturnTo } from "../../src/lib/navigation-return";
import { getCatalog } from "../../src/local-ai/catalog/catalog";
import type { ModelLicense } from "../../src/local-ai/types";

type SearchParamValue = string | string[] | undefined;

function getFirstSearchParam(value: SearchParamValue): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return null;
}

export const metadata: Metadata = {
  title: "Model licenses — Eco",
  description:
    "The license each AI model Eco downloads is published under, and who wrote it.",
};

type LicenseRow = {
  key: string;
  /** Every catalog build that resolves to this upstream work. */
  names: string[];
  vendor: string;
  license: ModelLicense;
};

/**
 * One row per licensed WORK, not per download build.
 *
 * Several catalog entries are the same model in different quantizations (the
 * f16 and plain-int4 1.2B, for instance). They share an author, an upstream
 * repo and a license, so listing them twice would read as a duplicate rather
 * than as information. Built from the catalog so a new model cannot ship
 * without appearing here.
 */
function buildLicenseRows(): LicenseRow[] {
  const rows = new Map<string, LicenseRow>();

  for (const model of getCatalog()) {
    const key = model.license.upstreamRepo;
    const existing = rows.get(key);
    if (existing) {
      if (!existing.names.includes(model.friendlyName)) {
        existing.names.push(model.friendlyName);
      }
      continue;
    }
    rows.set(key, {
      key,
      names: [model.friendlyName],
      vendor: model.vendor,
      license: model.license,
    });
  }

  return [...rows.values()];
}

const LINK_CLASS =
  "font-medium underline transition-colors hover:text-[var(--eco-text)]";

export default function LicensesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, SearchParamValue>>;
}) {
  const resolvedSearchParams = searchParams ? use(searchParams) : undefined;
  const requestedReturnTo = getFirstSearchParam(resolvedSearchParams?.returnTo);
  const returnTo = requestedReturnTo ? resolveReturnTo(requestedReturnTo, "/") : null;
  const appHref = resolvePublicAppDestination(requestedReturnTo);
  const rows = buildLicenseRows();

  return (
    <div className="grain relative min-h-dvh overflow-x-hidden bg-[var(--eco-surface)]">
      {/* Soft glow */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div
          className="absolute left-1/2 top-0 h-[400px] w-[600px] -translate-x-1/2 rounded-full opacity-[0.06] blur-[100px]"
          style={{ backgroundColor: "var(--eco-primary)" }}
        />
      </div>

      <div className="relative z-10">
        <PublicNav />

        {returnTo && (
          <div className="mx-auto max-w-3xl px-6 pt-6">
            <Link
              href={returnTo}
              className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] px-4 py-2 text-sm font-medium text-[var(--eco-text)] transition-colors hover:border-[var(--eco-primary)] hover:text-[var(--eco-primary)]"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" />
              </svg>
              Back to app
            </Link>
          </div>
        )}

        <main className="mx-auto max-w-3xl min-w-0 px-4 py-16 sm:px-6 sm:py-24">
          {/* Header */}
          <div className="mb-12 flex flex-col items-center gap-6">
            <Link href={appHref} aria-label="Go to chat" className="inline-flex min-h-11 min-w-11 items-center justify-center">
              <EcoLogo size="md" />
            </Link>
            <h1 className="font-serif font-medium tracking-tight text-[var(--eco-text)]" style={{ fontSize: 'clamp(2rem, 1rem + 5vw, 3rem)' }}>
              Model licenses
            </h1>
            <p className="text-base text-[var(--eco-text-secondary)]">
              Last updated: August 29, 2026
            </p>
          </div>

          {/* Content */}
          <article className="min-w-0 space-y-10 text-base leading-relaxed text-[var(--eco-text-secondary)] [overflow-wrap:anywhere]">
            <section>
              <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
                Two different licenses
              </h2>
              <p className="mb-3">
                Eco&apos;s own software is open source under the{" "}
                <strong className="text-[var(--eco-text)]">AGPL-3.0</strong>. The
                AI models are not ours: each one is a separate work, written by
                someone else and published under its own license. Downloading a
                model in Eco means accepting that model&apos;s license as well.
              </p>
              <p>
                Not every model here is open-source licensed. The Liquid AI
                models are published under the LFM Open License, which limits
                commercial use &mdash; the details are on each row below. The
                full text of each license is linked from its row, and a verbatim
                copy of every one is published in Eco&apos;s own source
                repository.
              </p>
            </section>

            <section>
              <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
                The models Eco can download
              </h2>
              <ul className="space-y-6">
                {rows.map((row) => (
                  <li
                    key={row.key}
                    className="rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-4"
                  >
                    <h3 className="font-medium text-[var(--eco-text)]">
                      {row.names.join(" / ")}
                    </h3>
                    <dl className="mt-3 space-y-2 text-sm">
                      <div className="flex flex-wrap gap-x-2">
                        <dt className="text-[var(--eco-text-muted)]">Published by</dt>
                        <dd className="text-[var(--eco-text)]">
                          {row.vendor} &mdash;{" "}
                          <a
                            href={`https://huggingface.co/${row.license.upstreamRepo}`}
                            className={LINK_CLASS}
                            style={{ color: "var(--eco-primary)" }}
                            rel="noreferrer noopener"
                            target="_blank"
                          >
                            {row.license.upstreamRepo}
                          </a>
                        </dd>
                      </div>
                      <div className="flex flex-wrap gap-x-2">
                        <dt className="text-[var(--eco-text-muted)]">License</dt>
                        <dd className="text-[var(--eco-text)]">
                          <a
                            href={row.license.url}
                            className={LINK_CLASS}
                            style={{ color: "var(--eco-primary)" }}
                            rel="noreferrer noopener"
                            target="_blank"
                          >
                            {row.license.name}
                          </a>
                        </dd>
                      </div>
                      {row.license.commercialUseNote && (
                        <div>
                          <dt className="text-[var(--eco-text-muted)]">Commercial use</dt>
                          <dd className="mt-1 text-[var(--eco-text)]">
                            {row.license.commercialUseNote}
                          </dd>
                        </div>
                      )}
                      {!row.license.confirmed && (
                        <div>
                          <dt className="text-[var(--eco-text-muted)]">License status</dt>
                          <dd className="mt-1 text-[var(--eco-text)]">
                            Declared by the publisher, not yet confirmed.
                          </dd>
                        </div>
                      )}
                    </dl>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
                Questions
              </h2>
              <p>
                If something on this page looks wrong &mdash; especially if you
                publish one of these models &mdash; write to{" "}
                <a
                  href="mailto:support@econetwork.ai"
                  className={LINK_CLASS}
                  style={{ color: "var(--eco-primary)" }}
                >
                  support@econetwork.ai
                </a>{" "}
                and we will correct it. Eco&apos;s own license is covered in the{" "}
                <Link
                  href="/terms"
                  className={LINK_CLASS}
                  style={{ color: "var(--eco-primary)" }}
                >
                  Terms of Service
                </Link>
                .
              </p>
            </section>
          </article>
        </main>

        <PublicFooter />
      </div>
    </div>
  );
}
