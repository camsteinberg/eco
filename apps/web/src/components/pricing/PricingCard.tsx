// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { Button } from "@eco/ui";

type PricingCardProps = {
  tier: string;
  price: string;
  period: string;
  features: string[];
  current?: boolean;
  onSelect?: () => void;
  ctaLabel?: string;
  /**
   * When true and the card is neither `current` nor selectable (`onSelect`
   * omitted), show a calm non-interactive "coming soon" mark instead of an
   * empty CTA slot. Used for the Supporter card in the free-only launch, where
   * Stripe isn't configured server-side and there's no honest checkout to offer.
   */
  comingSoon?: boolean;
};

export function PricingCard({
  tier,
  price,
  period,
  features,
  current = false,
  onSelect,
  ctaLabel = "Become a Supporter",
  comingSoon = false,
}: PricingCardProps) {
  const periodLabel = period.startsWith("/") ? period : `/${period}`;

  return (
    <div
      className={[
        "border p-5 bg-[var(--eco-surface-elevated)]",
        current
          ? "border-[var(--eco-primary)]"
          : "border-[var(--eco-border)]",
      ].join(" ")}
      style={{ borderRadius: 'var(--eco-radius-md)' }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-[var(--eco-text)]">
          {tier}
        </h3>
        {current && (
          <span className="rounded-full bg-[var(--eco-primary-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--eco-primary)]">
            Current
          </span>
        )}
      </div>

      <div className="mt-3">
        <span className="text-3xl font-semibold text-[var(--eco-text)]">
          {price}
        </span>
        <span className="ml-1 text-sm text-[var(--eco-text-secondary)]">
          {periodLabel}
        </span>
      </div>

      <ul className="mt-5 space-y-2.5">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-sm text-[var(--eco-text-secondary)]">
            <svg
              className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--eco-accent)' }}
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
                clipRule="evenodd"
              />
            </svg>
            {feature}
          </li>
        ))}
      </ul>

      {onSelect && !current && (
        <div className="mt-5">
          <Button onClick={onSelect} className="w-full">
            {ctaLabel}
          </Button>
        </div>
      )}

      {!onSelect && !current && comingSoon && (
        <div className="mt-5">
          <div
            className="flex w-full items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium text-[var(--eco-text-secondary)]"
            style={{
              backgroundColor: "var(--eco-primary-soft)",
              borderRadius: "var(--eco-radius-full)",
            }}
          >
            <svg
              className="h-4 w-4 shrink-0"
              style={{ color: "var(--eco-primary)" }}
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 000-1.5h-3.25V5z"
                clipRule="evenodd"
              />
            </svg>
            Coming soon
          </div>
        </div>
      )}
    </div>
  );
}
