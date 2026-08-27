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
  title: "Transparency | Eco",
  description:
    "How Eco web v1.0 works: on-device, browser-local AI chat, infrastructure disclosure, and open source code.",
};

function SectionDivider() {
  return (
    <div className="flex items-center justify-center py-2" aria-hidden="true">
      <svg width="24" height="12" viewBox="0 0 24 12" fill="none">
        <path
          d="M12 2C10 4 7 6 4 6C7 6 10 8 12 10C14 8 17 6 20 6C17 6 14 4 12 2Z"
          fill="var(--eco-primary)"
          opacity="0.15"
        />
        <path
          d="M12 2C10 4 7 6 4 6C7 6 10 8 12 10C14 8 17 6 20 6C17 6 14 4 12 2Z"
          stroke="var(--eco-primary)"
          strokeWidth="0.5"
          opacity="0.3"
        />
      </svg>
    </div>
  );
}

export default function TransparencyPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, SearchParamValue>>;
}) {
  const resolvedSearchParams = searchParams ? use(searchParams) : undefined;
  const requestedReturnTo = getFirstSearchParam(resolvedSearchParams?.returnTo);
  const returnTo = requestedReturnTo ? resolveReturnTo(requestedReturnTo, "/") : null;
  const appHref = resolvePublicAppDestination(requestedReturnTo);

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
            <h1
              className="font-display font-medium tracking-tight text-[var(--eco-text)]"
              style={{
                fontSize: "clamp(2rem, 1rem + 5vw, 3rem)",
              }}
            >
              Transparency
            </h1>
            <p className="text-base text-[var(--eco-text-secondary)]">
              How our system works, and what we can and cannot see.
            </p>
          </div>

        {/* Content */}
        <article className="min-w-0 space-y-10 text-base leading-relaxed text-[var(--eco-text-secondary)] [overflow-wrap:anywhere]">
          {/* Section 1: Our Commitment */}
          <section>
            <h2 className="mb-3 font-display text-xl font-medium text-[var(--eco-text)]">
              Our Commitment
            </h2>
            <p>
              Eco is built on radical transparency. We publish exactly how the
              system works because privacy claims are only meaningful when they
              can be verified. Every line of code is open source under the{" "}
              <strong className="text-[var(--eco-text)]">
                AGPL-3.0
              </strong>{" "}
              license &mdash; anyone can inspect, audit, and confirm our
              architecture enforces what we promise.
            </p>
          </section>

          <SectionDivider />

          {/* Section 2: How Eco Works */}
          <section>
            <h2 className="mb-3 font-display text-xl font-medium text-[var(--eco-text)]">
              How Eco Works
            </h2>
            <p className="mb-3">
              Eco web v1.0 runs the AI model on your device, inside your browser.
              Your conversations are not sent to Eco servers for inference.
            </p>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong className="text-[var(--eco-text)]">
                  On-device inference
                </strong>{" "}
                &mdash; your query runs entirely in your browser. Your prompts
                and responses do not leave your machine to be processed.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Local storage
                </strong>{" "}
                &mdash; conversations you keep are stored in your browser on your
                own device, and you can clear them at any time.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Model downloads
                </strong>{" "}
                &mdash; to run a model on your device, Eco downloads the model
                files to your browser. Those requests carry only model file
                names, never your conversation.
              </li>
            </ul>
            <p className="mt-4 rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-4 text-[var(--eco-text)]">
              Your conversations stay on your device. The AI runs in your
              browser, so we never receive your prompts or responses to generate
              an answer.
            </p>
            <p className="mt-3 rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-4 text-[var(--eco-text)]">
              <strong className="text-[var(--eco-text)]">
                Web lookups (optional, on by default).
              </strong>{" "}
              For factual questions, Eco can check Wikipedia and Wikidata so it
              cites a real source instead of guessing. When this is on, your browser
              fetches the search terms from your question directly from
              Wikimedia. Eco&apos;s servers never see or store any of this, and your
              full conversation is never sent; only those search terms reach the
              provider, subject to its own privacy policy, much like visiting the
              site yourself. Turn it off in Settings &rarr; Eco to keep every
              request fully on your device.
            </p>
          </section>

          <SectionDivider />

          {/* Section 3: On-Device Inference */}
          <section>
            <h2 className="mb-3 font-display text-xl font-medium text-[var(--eco-text)]">
              On-Device Inference
            </h2>
            <div className="space-y-4">
              <div className="rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full"
                    style={{ backgroundColor: "var(--eco-mint)" }}
                    aria-hidden="true"
                  >
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="white">
                      <path d="M6 1L2 3v3c0 2.73 1.7 5.28 4 6 2.3-.72 4-3.27 4-6V3L6 1z" />
                    </svg>
                  </span>
                  <strong className="text-[var(--eco-text)]">
                    Your conversation stays on your device
                  </strong>
                </div>
                <p>
                  The AI model runs in your browser, so your prompts and
                  responses are not sent to us to generate an answer. We
                  can&apos;t see your conversation content because it never
                  reaches our servers.
                </p>
              </div>

              <div className="rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full"
                    style={{ backgroundColor: "var(--eco-primary)" }}
                    aria-hidden="true"
                  >
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="white">
                      <rect x="2" y="4" width="8" height="6" rx="1" />
                      <path d="M4 4V3a2 2 0 114 0v1" fill="none" stroke="white" strokeWidth="1" />
                    </svg>
                  </span>
                  <strong className="text-[var(--eco-text)]">
                    You control local storage
                  </strong>
                </div>
                <p>
                  Conversations you choose to keep are stored in your browser on
                  your own device. You can clear them at any time, and we have no
                  way to read your local browser storage.
                </p>
              </div>
            </div>
          </section>

          <SectionDivider />

          {/* Section 4: What We Can See */}
          <section>
            <h2 className="mb-3 font-display text-xl font-medium text-[var(--eco-text)]">
              What We Can See
            </h2>
            <p className="mb-3">
              The Eco API gateway has access to the following operational data:
            </p>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong className="text-[var(--eco-text)]">
                  Account email
                </strong>{" "}
                &mdash; if you register an account (optional for local use)
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Operational metadata
                </strong>{" "}
                &mdash; request timestamps, IP addresses, and HTTP metadata used
                for security, rate limiting, and abuse prevention
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Feedback you choose to send
                </strong>{" "}
                &mdash; the message you type, plus two independent opt-in
                attachments: a short device summary (browser, memory, GPU) and a
                recent-failures summary from the local diagnostic ledger (dates,
                model identifiers, error codes, backend). Both include the model
                identifier. Nothing is sent unless you submit it.
              </li>
            </ul>
          </section>

          <SectionDivider />

          {/* Section 5: What We Cannot See */}
          <section>
            <h2 className="mb-3 font-display text-xl font-medium text-[var(--eco-text)]">
              What Eco Operators Cannot See
            </h2>
            <p className="mb-3">
              The following data is designed to stay out of Eco operator view:
            </p>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong className="text-[var(--eco-text)]">
                  Your conversation content
                </strong>{" "}
                &mdash; the AI model runs in your browser, so your prompts and
                responses are not sent to us. We have no mechanism to access
                them.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Your local conversation history
                </strong>{" "}
                &mdash; stored in browser storage on your device. We don&apos;t
                have access to your local browser storage.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Your chats or how often you chat
                </strong>{" "}
                &mdash; the AI runs in your browser, so we never see your
                prompts, responses, or chat frequency. Because model files are
                delivered through Eco&apos;s hosting today, the hosting provider
                can see which model file an IP address downloads &mdash; but
                nothing about what you do with it afterward.
              </li>
            </ul>
          </section>

          <SectionDivider />

          {/* Section 6: The Code */}
          <section>
            <h2 className="mb-3 font-display text-xl font-medium text-[var(--eco-text)]">
              The Code
            </h2>
            <p>
              Eco is fully open source under the{" "}
              <strong className="text-[var(--eco-text)]">
                GNU Affero General Public License v3.0 (AGPL-3.0)
              </strong>
              . Every line of code is auditable. Our privacy architecture can be
              independently confirmed &mdash; you never have to take our word
              for it.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <a
                href="https://github.com/camsteinberg/eco"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--eco-border)] px-4 py-2 text-sm font-medium text-[var(--eco-text)] transition-colors hover:border-[var(--eco-primary)] hover:text-[var(--eco-primary)]"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
                View on GitHub
              </a>
            </div>
            <p className="mt-3 text-sm opacity-80">
              If you find something that contradicts our launch claims, please
              tell us.
            </p>
          </section>

          <SectionDivider />

          {/* Section 7: Infrastructure */}
          <section>
            <h2 className="mb-3 font-display text-xl font-medium text-[var(--eco-text)]">
              Infrastructure
            </h2>
            <p className="mb-3">
              In the spirit of transparency, here is where your data lives and
              who processes it:
            </p>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong className="text-[var(--eco-text)]">
                  Web app
                </strong>{" "}
                &mdash; hosted on Vercel. The AI model runs in your browser; chat
                inference is not processed on the server.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  API gateway
                </strong>{" "}
                &mdash; hosted on Fly.io. Handles authentication only; it does
                not process your conversations.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Database
                </strong>{" "}
                &mdash; PostgreSQL on Neon (accounts &mdash; never conversation
                content)
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Model delivery
                </strong>{" "}
                &mdash; model files are delivered through Eco&apos;s web host
                (Vercel), which proxies them from Hugging Face. Vercel sees your
                IP address and which model file is requested. When a direct CDN
                path is configured (Cloudflare R2), Cloudflare sees the same
                metadata instead. Neither provider ever sees your conversations.
              </li>
            </ul>
          </section>

          <SectionDivider />

          {/* Section 8: Contact */}
          <section>
            <h2 className="mb-3 font-display text-xl font-medium text-[var(--eco-text)]">
              Contact
            </h2>
            <p>
              Questions about our transparency practices or privacy concerns?
              Contact us at{" "}
              <a
                href="mailto:support@econetwork.ai"
                className="font-medium underline transition-colors hover:text-[var(--eco-text)]"
                style={{ color: "var(--eco-primary)" }}
              >
                support@econetwork.ai
              </a>
              . We take every report seriously and will respond within 48 hours.
            </p>
          </section>
        </article>

        </main>

        <PublicFooter />
      </div>
    </div>
  );
}
