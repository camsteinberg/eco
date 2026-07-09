// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import Link from "next/link";
import { SeedlingIllustration } from "../illustrations/SeedlingIllustration";
import { PublicFooter } from "./PublicFooter";
import { PublicNav } from "./PublicNav";
import { RetiredRouteAuthGate } from "./RetiredRouteAuthGate";

type RouteAction = {
  href: string;
  label: string;
  external?: boolean;
};

type RetiredRoutePageProps = {
  eyebrow: string;
  title: string;
  description: string;
  bullets: string[];
  statusLabel?: string;
  primaryAction: RouteAction;
  secondaryAction?: RouteAction;
  note?: string;
};

function ActionLink({
  action,
  variant = "primary",
}: {
  action: RouteAction;
  variant?: "primary" | "secondary";
}) {
  const className =
    variant === "primary"
      ? "inline-flex min-h-11 items-center justify-center rounded-full px-5 py-3 text-sm font-medium text-white transition-all hover:opacity-95"
      : "inline-flex min-h-11 items-center justify-center rounded-full border border-[var(--eco-border)] px-5 py-3 text-sm font-medium text-[var(--eco-text)] transition-colors hover:border-[var(--eco-primary)] hover:text-[var(--eco-primary)]";

  const content = (
    <>
      {action.label}
      {action.external && (
        <svg
          aria-hidden="true"
          className="ml-2 h-4 w-4"
          fill="none"
          viewBox="0 0 20 20"
        >
          <path
            d="M7 13L13 7M8 7h5v5"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
          />
        </svg>
      )}
    </>
  );

  if (action.external) {
    return (
      <a
        className={className}
        href={action.href}
        rel="noreferrer noopener"
        style={
          variant === "primary"
            ? { backgroundColor: "var(--eco-primary)" }
            : undefined
        }
        target="_blank"
      >
        {content}
      </a>
    );
  }

  return (
    <Link
      className={className}
      href={action.href}
      style={
        variant === "primary"
          ? { backgroundColor: "var(--eco-primary)" }
          : undefined
      }
    >
      {content}
    </Link>
  );
}

export function RetiredRoutePage({
  eyebrow,
  title,
  description,
  bullets,
  statusLabel = "Coming later",
  primaryAction,
  secondaryAction,
  note,
}: RetiredRoutePageProps) {
  return (
    <div className="grain min-h-screen bg-[var(--eco-surface)]">
      <RetiredRouteAuthGate />
      <PublicNav />

      <main className="px-4 py-10 sm:px-6 sm:py-14 lg:px-10">
        <div className="mx-auto max-w-4xl">
          <section className="overflow-hidden rounded-2xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] shadow-xl">
            <div
              aria-hidden="true"
              className="h-2 w-full"
              style={{
                background:
                  "linear-gradient(90deg, var(--eco-primary), color-mix(in srgb, var(--eco-mint) 72%, white 28%))",
              }}
            />

            <div className="grid gap-10 px-6 py-10 sm:px-10 sm:py-12 lg:grid-cols-[0.95fr_1.15fr] lg:items-center">
              <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
                <div
                  className="flex h-28 w-28 items-center justify-center rounded-full border border-[var(--eco-border)] bg-[var(--eco-primary-soft)]"
                  style={{ color: "var(--eco-primary)" }}
                >
                  <SeedlingIllustration className="h-16 w-16" />
                </div>

                <div className="mt-6 flex flex-wrap items-center justify-center gap-2 lg:justify-start">
                  <span className="rounded-full bg-[var(--eco-primary-soft)] px-3 py-1 text-xs font-medium text-[var(--eco-primary)]">
                    {statusLabel}
                  </span>
                  <span className="rounded-full border border-[var(--eco-border)] px-3 py-1 text-xs font-medium text-[var(--eco-text-secondary)]">
                    Chat-first launch
                  </span>
                </div>
              </div>

              <div>
                <p className="text-sm font-medium uppercase tracking-[0.18em] text-[var(--eco-text-muted)]">
                  {eyebrow}
                </p>
                <h1 className="mt-4 font-display text-3xl font-medium tracking-[-0.03em] text-[var(--eco-text)] sm:text-4xl">
                  {title}
                </h1>
                <p className="mt-4 max-w-2xl text-base leading-7 text-[var(--eco-text-secondary)]">
                  {description}
                </p>

                <ul className="mt-6 space-y-3">
                  {bullets.map((bullet) => (
                    <li
                      key={bullet}
                      className="flex items-start gap-3 text-sm leading-6 text-[var(--eco-text-secondary)]"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-2 h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: "var(--eco-primary)" }}
                      />
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                  <ActionLink action={primaryAction} />
                  {secondaryAction ? (
                    <ActionLink action={secondaryAction} variant="secondary" />
                  ) : null}
                </div>

                {note ? (
                  <p className="mt-5 text-sm leading-6 text-[var(--eco-text-muted)]">
                    {note}
                  </p>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      </main>

      <PublicFooter />
    </div>
  );
}
