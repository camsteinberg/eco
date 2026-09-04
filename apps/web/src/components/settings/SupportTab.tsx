// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import Link from "next/link";
import { useState } from "react";
import { withReturnTo } from "../../lib/navigation-return";
import { FeedbackDialog } from "../feedback/FeedbackDialog";
import { SettingsSection } from "./SettingsSection";

const supportChannels = [
  {
    label: "Email us",
    href: "mailto:support@econetwork.ai",
    description: "Chat, models, privacy, legal, or account questions.",
  },
] as const;

const trustResources = [
  { label: "How Eco saves water", href: withReturnTo("/impact") },
  { label: "Transparency", href: withReturnTo("/transparency") },
  { label: "Privacy policy", href: withReturnTo("/privacy") },
  { label: "Terms", href: withReturnTo("/terms") },
] as const;

export function SupportTab() {
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  return (
    <div>
      <SettingsSection title="Get in touch" hairline={false}>
        <ul className="divide-y divide-[var(--eco-border-muted)]">
          <li>
            <button
              type="button"
              onClick={() => {
                setFeedbackOpen(true);
              }}
              className="group flex w-full items-start justify-between gap-4 py-3 text-left transition-colors"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--eco-text)] group-hover:text-[var(--eco-primary)]">
                  Send feedback
                </p>
                <p className="mt-1 text-xs leading-relaxed text-[var(--eco-text-secondary)]">
                  Anonymous, straight to the people building Eco.
                </p>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1.5 self-center text-xs font-medium text-[var(--eco-text-secondary)] group-hover:text-[var(--eco-primary)]">
                Open
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
                >
                  <path fillRule="evenodd" d="M3.22 10a.75.75 0 01.75-.75h10.19L10.47 5.53a.75.75 0 111.06-1.06l5 5a.75.75 0 010 1.06l-5 5a.75.75 0 01-1.06-1.06l3.69-3.72H3.97A.75.75 0 013.22 10z" clipRule="evenodd" />
                </svg>
              </span>
            </button>
          </li>
          {supportChannels.map((channel) => (
            <li key={channel.href}>
              <a
                href={channel.href}
                className="group flex items-start justify-between gap-4 py-3 transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--eco-text)] group-hover:text-[var(--eco-primary)]">
                    {channel.label}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--eco-text-secondary)]">
                    {channel.description}
                  </p>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1.5 self-center text-xs font-medium text-[var(--eco-text-secondary)] group-hover:text-[var(--eco-primary)]">
                  {channel.href.replace("mailto:", "")}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
                  >
                    <path fillRule="evenodd" d="M3.22 10a.75.75 0 01.75-.75h10.19L10.47 5.53a.75.75 0 111.06-1.06l5 5a.75.75 0 010 1.06l-5 5a.75.75 0 01-1.06-1.06l3.69-3.72H3.97A.75.75 0 013.22 10z" clipRule="evenodd" />
                  </svg>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </SettingsSection>

      <SettingsSection title="Learn about Eco">
        <ul className="divide-y divide-[var(--eco-border-muted)]">
          {trustResources.map((resource) => (
            <li key={resource.href}>
              <Link
                href={resource.href}
                className="group flex items-center justify-between gap-4 py-3 transition-colors hover:text-[var(--eco-primary)]"
              >
                <span className="text-sm text-[var(--eco-text)] group-hover:text-[var(--eco-primary)]">
                  {resource.label}
                </span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-4 w-4 shrink-0 text-[var(--eco-text-secondary)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--eco-primary)]"
                >
                  <path fillRule="evenodd" d="M11.22 4.22a.75.75 0 011.06 0l5 5a.75.75 0 010 1.06l-5 5a.75.75 0 11-1.06-1.06l3.72-3.72H4a.75.75 0 010-1.5h10.94l-3.72-3.72a.75.75 0 010-1.06z" clipRule="evenodd" />
                </svg>
              </Link>
            </li>
          ))}
        </ul>
      </SettingsSection>

      <FeedbackDialog
        open={feedbackOpen}
        onClose={() => {
          setFeedbackOpen(false);
        }}
      />
    </div>
  );
}
