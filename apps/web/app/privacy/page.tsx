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
  title: "Privacy Policy — Eco",
  description:
    "Privacy Policy for Eco web v1.0: on-device, browser-local AI chat.",
};

export default function PrivacyPage({
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
          <h1 className="font-serif font-medium tracking-tight text-[var(--eco-text)]" style={{ fontSize: 'clamp(2rem, 1rem + 5vw, 3rem)' }}>
            Privacy Policy
          </h1>
          <p className="text-base text-[var(--eco-text-secondary)]">
            Last updated: August 27, 2026
          </p>
        </div>

        {/* Content */}
        <article className="min-w-0 space-y-10 text-base leading-relaxed text-[var(--eco-text-secondary)] [overflow-wrap:anywhere]">
          {/* Intro */}
          <section>
            <p>
              Eco is operated by Bos Computing LLC (&ldquo;we,&rdquo;
              &ldquo;us,&rdquo; or &ldquo;our&rdquo;), a Wyoming limited
              liability company. We believe that AI should respect your privacy.
              This policy explains what data we collect, what we don&apos;t
              collect, and how Eco web v1.0 keeps your conversations on your
              device by running the AI model in your own browser. We
              aim to be straightforward &mdash; no legalese where plain language
              will do.
            </p>
          </section>

          {/* 1. What We Collect */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              1. What We Collect
            </h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong className="text-[var(--eco-text)]">Account information:</strong>{" "}
                Email address and display name when you create an account
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Usage metrics:</strong>{" "}
                Aggregate request metrics for our account API
                &mdash; request counts, response timing, and error rates &mdash;
                for reliability and security. Your chat activity (how often you
                chat, timing, and the model you use) is measured on your device
                and never sent to Eco unless you choose to submit
                feedback (see Section 6)
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Device information:</strong>{" "}
                Browser type and version for compatibility purposes (no
                fingerprinting)
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Server logs:</strong>{" "}
                IP addresses, request timestamps, and HTTP metadata for security
                and abuse prevention
              </li>
            </ul>
          </section>

          {/* 2. What We Do Not Collect */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              2. What We Do Not Collect
            </h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong className="text-[var(--eco-text)]">
                  Your conversation content
                </strong>{" "}
                &mdash; the AI model runs in your browser, so your prompts and
                responses are not sent to Eco servers for inference
              </li>
              <li>Browsing history or activity outside the Eco service</li>
              <li>Third-party tracking data, advertising identifiers, or analytics cookies</li>
              <li>Biometric data or precise location data</li>
              <li>Your contacts or social graph (signing in with a provider
                gives us only the basics listed in Section 6)</li>
            </ul>
            <p className="mt-3">
              <strong className="text-[var(--eco-text)]">
                We do not use your inputs or outputs to train AI models.
              </strong>
            </p>
          </section>

          {/* 3. Legal Basis for Processing */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              3. Legal Basis for Processing
            </h2>
            <p className="mb-3">
              For users in the European Economic Area (EEA), United Kingdom, and
              other jurisdictions that require a legal basis for data processing,
              we process your personal data on the following grounds:
            </p>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong className="text-[var(--eco-text)]">
                  Contractual necessity
                </strong>{" "}
                &mdash; Account creation and authentication are necessary to
                provide the Service you requested (GDPR Article 6(1)(b))
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Legitimate interest
                </strong>{" "}
                &mdash; Usage metrics, device information, and server logs are
                processed for service improvement, security monitoring, and
                abuse prevention. We have balanced these interests against your
                rights and determined they do not override your fundamental
                freedoms (GDPR Article 6(1)(f))
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Consent
                </strong>{" "}
                &mdash; Where we rely on consent for optional processing, you
                may withdraw it at any time without affecting the lawfulness of
                prior processing (GDPR Article 6(1)(a)).
              </li>
            </ul>
          </section>

          {/* 4. How On-Device Chat Protects Your Privacy */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              4. How On-Device Chat Protects Your Privacy
            </h2>
            <p className="mb-4">
              Eco web v1.0 runs the AI model on your device, inside your browser.
              Your conversations are not sent to Eco servers for inference.
            </p>

            <div className="space-y-4">
              <div className="rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-5">
                <h3 className="mb-1 font-medium text-[var(--eco-text)]">
                  On-device inference
                </h3>
                <p>
                  When you chat, your prompts and the model&apos;s responses are
                  processed in your browser. They are not transmitted to Eco
                  servers to generate the response, so we cannot see your
                  conversation content.
                </p>
              </div>

              <div className="rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-5">
                <h3 className="mb-1 font-medium text-[var(--eco-text)]">
                  Local storage of conversations
                </h3>
                <p>
                  If you keep a conversation, it can persist in your browser
                  storage (such as IndexedDB or the Origin Private File System)
                  on your own device. It stays on your device, and you can clear
                  it from your browser at any time.
                </p>
              </div>

              <div className="rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-5">
                <h3 className="mb-1 font-medium text-[var(--eco-text)]">
                  Model downloads
                </h3>
                <p>
                  To run a model on your device, Eco downloads the model files to
                  your browser the first time. Those requests carry only model
                  file names &mdash; never your prompts, files, conversations, or
                  the model&apos;s replies.
                </p>
              </div>

              <div className="rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-5">
                <h3 className="mb-1 font-medium text-[var(--eco-text)]">
                  Web lookups (Wikipedia and Wikidata)
                </h3>
                <p>
                  To help the AI answer factual questions with real sources
                  instead of guessing, Eco includes an optional &ldquo;Look up
                  facts from the web&rdquo; feature, on by default. When it is on,
                  your browser contacts Wikipedia and Wikidata directly to fetch
                  the search terms from your question. These requests go straight
                  from your device to those providers &mdash; they are not routed
                  through, seen by, or stored on Eco&apos;s servers &mdash; and
                  only the search terms are sent, never your full conversation.
                  Each provider receives the request (including your IP address
                  and the terms) under its own privacy policy, as it would if you
                  visited the site yourself. You can turn this off at any time in
                  Settings &rarr; Eco; with it off, lookups stop and your requests
                  stay entirely on your device.
                </p>
              </div>
            </div>
          </section>

          {/* 5. Cookies and local storage */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              5. Cookies and local storage
            </h2>
            <p>
              Eco uses session cookies for authentication (powered by Better
              Auth) and a launch-gate cookie when pre-launch access is
              enabled. These are{" "}
              <strong className="text-[var(--eco-text)]">
                strictly necessary
              </strong>{" "}
              for the Service to function or remember your local choices. We do
              not use tracking cookies, advertising cookies, or any third-party
              cookie-based analytics.
            </p>
            <p className="mt-3">
              Eco also uses local or session storage for browser-only state such
              as theme preference, cookie-notice preference, one-time prompt
              handoff, guest chat context, composer draft, a local diagnostic
              failure ledger (dates, model identifiers, error codes, and
              backend), onboarding/workspace settings, service-worker recovery
              metadata, and on-device model cache state. Local model files and cache
              records stay in your browser storage so guests can prepare local
              AI without an account. Clearing browser storage may reset those
              local preferences or require model preparation again.
            </p>
            <p className="mt-3">
              Preparing a local model downloads the model files to your browser.
              Those requests carry only model file names, not your prompts,
              uploaded files, conversations, or generated responses.
            </p>
            <p className="mt-3">
              If local AI fails, Eco can prepare a support report that stays in
              your browser until you copy or download it. That report may include
              browser class, device memory bucket, model readiness, cache status,
              compatibility blockers, and error codes. It is designed to exclude
              prompts, generated text, uploaded file contents, account content,
              raw URLs, and secrets.
            </p>
          </section>

          {/* 6. Third-Party Services and Data Processors */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              6. Third-Party Services and Data Processors
            </h2>
            <p className="mb-3">
              We use the following third-party services to operate Eco. Each
              processes data on our behalf and is bound by their respective
              privacy policies and, where applicable, data processing
              agreements:
            </p>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong className="text-[var(--eco-text)]">Sentry</strong>{" "}
                &mdash; Server-side error monitoring for our authentication
                API, so we can catch and fix failures. It does not
                receive your prompts, conversations, or generated text &mdash;
                those stay on your device &mdash; and request bodies, IP
                addresses, and cookies are not sent. Sentry is not used in the
                web app itself.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Resend</strong>{" "}
                &mdash; Sends transactional email on our behalf (password
                resets, verification links, magic links). Resend receives
                your email address and the message content; it does not
                receive your conversations or chat data.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  OAuth providers (Google, GitHub, Apple)
                </strong>{" "}
                &mdash; If you choose to sign in with one of these providers,
                Eco receives your email address, display name, profile image,
                and authentication tokens from that provider. We do not request
                or receive your contacts, social graph, or other account data.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Vercel</strong>{" "}
                &mdash; Hosts the Eco website and currently proxies model file
                downloads from Hugging Face. Vercel sees your IP address,
                request metadata, and which model file is requested. It does
                not see your conversations.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Fly.io</strong>{" "}
                &mdash; Hosts the API gateway (authentication). Processes
                request metadata, server logs, and application data.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Neon</strong>{" "}
                &mdash; Managed PostgreSQL database. Stores account
                information (including a password hash when you use email
                sign-in, or OAuth tokens when you use a provider),
                session records (IP address and user agent, retained for
                30 days), and feedback you choose to send us. Feedback
                includes the message you type and, independently, two
                opt-in attachments you control: a short device summary
                (browser, memory, GPU, model identifier) and a
                recent-failures summary from your local diagnostic ledger
                (dates, model identifiers, error codes, backend).
                Located in US East.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Upstash</strong>{" "}
                &mdash; Managed Redis. Used for service health checks and
                short-lived rate-limit counters derived from your IP address for
                abuse prevention; we do not store prompts, conversations, or
                account content here. Located in US East. Connections are
                encrypted in transit.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Hugging Face
                </strong>{" "}
                &mdash; Origin host for model files. Vercel proxies model
                downloads from Hugging Face. Hugging Face sees the server
                request but not your IP address (Vercel&apos;s IP is used).
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Cloudflare</strong>{" "}
                &mdash; When a direct CDN path is configured (Cloudflare R2),
                model files are served through Cloudflare instead of Vercel.
                Cloudflare sees your IP address and which model file is
                requested &mdash; never your conversations.
              </li>
            </ul>
            <p className="mt-3">
              If we ever offer a paid plan, Stripe would process your payment
              and receive your account email; no payment data is stored on
              Eco&apos;s servers. Beyond the processors listed above, we do not
              sell, rent, or share your personal data with third parties. We
              do not share data with advertisers. We may disclose data if
              required by law, regulation, or valid legal process.
            </p>
          </section>

          {/* 7. International Data Transfers */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              7. International Data Transfers
            </h2>
            <p className="mb-3">
              Eco is operated from the United States. Our primary infrastructure
              (API, database, cache) is located in the US East region. If you
              access the Service from outside the United States, the account
              and operational data we process will be transferred to and
              processed in the United States.
            </p>
            <p className="mb-3">
              Your conversation content stays on your device, because the AI model
              runs in your browser. It is not transferred to us or to any other
              country for inference.
            </p>
            <p>
              For users in the EEA and UK, we rely on the European
              Commission&apos;s adequacy decisions where applicable, and
              Standard Contractual Clauses (SCCs) with our sub-processors that
              operate outside of jurisdictions with adequate data protection
              laws. If you have questions about specific transfer safeguards,
              contact us at{" "}
              <a
                href="mailto:support@econetwork.ai"
                className="font-medium underline transition-colors hover:text-[var(--eco-text)]"
                style={{ color: "var(--eco-primary)" }}
              >
                support@econetwork.ai
              </a>
              .
            </p>
          </section>

          {/* 8. Data Retention */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              8. Data Retention
            </h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong className="text-[var(--eco-text)]">Account data:</strong>{" "}
                Retained while your account is active. Upon account deletion,
                your personal data is permanently erased within 30 days, except
                where retention is required by law.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Server logs:</strong>{" "}
                Retained for 90 days, then automatically purged
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Conversation content:</strong>{" "}
                Processed on your device in your browser; we do not receive or
                retain it. Any conversations you keep are stored locally in your
                browser and can be cleared by you at any time.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Rate limiting data:</strong>{" "}
                Temporary, expires automatically (typically within minutes to
                hours)
              </li>
            </ul>
          </section>

          {/* 9. Your Rights */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              9. Your Rights
            </h2>
            <p className="mb-3">
              Regardless of where you are located, we respect your data rights.
              Under GDPR, CCPA, and similar regulations, you have the right to:
            </p>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong className="text-[var(--eco-text)]">Access</strong>{" "}
                &mdash; Request a copy of the personal data we hold about you
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Deletion</strong>{" "}
                &mdash; Request that we delete your account and associated data
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Export</strong>{" "}
                &mdash; Receive your data in a portable, machine-readable format
                (data portability)
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Correction</strong>{" "}
                &mdash; Update or correct inaccurate personal information
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Restriction</strong>{" "}
                &mdash; Request that we limit how we process your data in
                certain circumstances
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Objection</strong>{" "}
                &mdash; Object to processing based on legitimate interest
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">Withdraw consent</strong>{" "}
                &mdash; Where processing is based on consent, withdraw at any
                time
              </li>
            </ul>
            <p className="mt-3">
              To exercise any of these rights, contact us at{" "}
              <a
                href="mailto:support@econetwork.ai"
                className="font-medium underline transition-colors hover:text-[var(--eco-text)]"
                style={{ color: "var(--eco-primary)" }}
              >
                support@econetwork.ai
              </a>
              . We will respond within 30 days. If you are in the EEA, you also
              have the right to lodge a complaint with your local supervisory
              authority.
            </p>
          </section>

          {/* 10. California Privacy Rights (CCPA/CPRA) */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              10. California Privacy Rights
            </h2>
            <p className="mb-3">
              If you are a California resident, you have additional rights under
              the California Consumer Privacy Act (CCPA) and the California
              Privacy Rights Act (CPRA):
            </p>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong className="text-[var(--eco-text)]">
                  Right to Know:
                </strong>{" "}
                You may request the categories and specific pieces of personal
                information we have collected about you in the past 12 months.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Right to Delete:
                </strong>{" "}
                You may request deletion of your personal information, subject
                to certain legal exceptions.
              </li>
              <li>
                <strong className="text-[var(--eco-text)]">
                  Right to Non-Discrimination:
                </strong>{" "}
                We will not discriminate against you for exercising your CCPA
                rights.
              </li>
            </ul>
            <p className="mt-3 rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-4 text-[var(--eco-text)]">
              <strong>We do not sell your personal information.</strong> We do
              not share your personal information for cross-context behavioral
              advertising. We do not use or disclose sensitive personal
              information for purposes other than providing the Service. No
              opt-out is required because we do not engage in these practices.
            </p>
            <p className="mt-3">
              <strong className="text-[var(--eco-text)]">
                Categories of personal information collected:
              </strong>{" "}
              Identifiers (email, display name), internet activity (usage
              metrics, server logs), and inferences drawn from the above for
              service improvement.
            </p>
          </section>

          {/* 11. Automated Decision-Making */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              11. Automated Decision-Making
            </h2>
            <p>
              Eco uses automated systems for rate limiting and abuse detection.
              These systems may affect your access to the Service (e.g.,
              temporary rate limit enforcement). We do not use automated
              decision-making that produces legal effects or similarly
              significant effects on individuals based solely on automated
              processing, including profiling, as defined under GDPR Article 22.
            </p>
          </section>

          {/* 12. Children's Privacy */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              12. Children&apos;s Privacy
            </h2>
            <p>
              Eco is not intended for children under the age of 13 (or 16 in
              the EEA). We do not knowingly collect personal information from
              children. If you believe a child under the applicable age has
              provided us with personal data, please contact us at{" "}
              <a
                href="mailto:support@econetwork.ai"
                className="font-medium underline transition-colors hover:text-[var(--eco-text)]"
                style={{ color: "var(--eco-primary)" }}
              >
                support@econetwork.ai
              </a>{" "}
              and we will promptly delete it.
            </p>
          </section>

          {/* 13. Changes to This Policy */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              13. Changes to This Policy
            </h2>
            <p>
              We may update this Privacy Policy from time to time. We will
              provide at least 30 days&apos; notice of material changes by
              posting the updated policy on this page, updating the &ldquo;Last
              updated&rdquo; date, and, where feasible, notifying you by email.
              Your continued use of the Service after the notice period
              constitutes acceptance of the revised policy. If you do not agree
              to the updated policy, you must stop using the Service.
            </p>
          </section>

          {/* 14. Contact and Data Protection */}
          <section>
            <h2 className="mb-3 font-serif text-xl font-medium text-[var(--eco-text)]">
              14. Contact and Data Protection
            </h2>
            <p className="mb-3">
              If you have questions about this Privacy Policy, how your data is
              handled, or wish to exercise your data rights, contact our data
              protection point of contact:
            </p>
            <p className="mb-3">
              <strong className="text-[var(--eco-text)]">
                Data Protection Contact
              </strong>
              <br />
              Bos Computing LLC
              <br />
              Email:{" "}
              <a
                href="mailto:support@econetwork.ai"
                className="font-medium underline transition-colors hover:text-[var(--eco-text)]"
                style={{ color: "var(--eco-primary)" }}
              >
                support@econetwork.ai
              </a>
            </p>
            <p>
              For general support inquiries, contact{" "}
              <a
                href="mailto:support@econetwork.ai"
                className="font-medium underline transition-colors hover:text-[var(--eco-text)]"
                style={{ color: "var(--eco-primary)" }}
              >
                support@econetwork.ai
              </a>
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
