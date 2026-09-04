// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import fs from "node:fs";
import path from "node:path";

let mockSearchParams = new URLSearchParams();

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

vi.mock("next/font/google", () => ({
  DM_Sans: () => ({ variable: "--font-sans" }),
  Fraunces: () => ({ variable: "--font-serif" }),
  JetBrains_Mono: () => ({ variable: "--font-mono" }),
}));

import GlobalError from "../../app/global-error";
import ImpactPage from "../../app/impact/page";
import manifest from "../../app/manifest";
import NotFound from "../../app/not-found";
import PrivacyPage from "../../app/privacy/page";
import TermsPage from "../../app/terms/page";
import TransparencyPage from "../../app/transparency/page";
import { metadata as rootMetadata } from "../../app/layout";
import { PublicFooter } from "../components/public/PublicFooter";
import { PublicNav } from "../components/public/PublicNav";

const WEB_ROOT = path.resolve(__dirname, "../..");

function renderedText(container: HTMLElement): string {
  return container.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

const ACTIVE_PRIVACY_OVERCLAIM_PATTERNS = [
  /end-to-end encryption/i,
  /encrypted end-to-end/i,
  /hardware-protected enclave/i,
  /hardware enclaves and split inference respectively/i,
  /processed inside a hardware Trusted Execution Environment/i,
  /not even (Eco|the contributor)/i,
  /no one\s+[—-]\s+not even/i,
  /the network cannot read your prompts or responses/i,
  /your prompt and response never leave your device/i,
];

const ACTIVE_PRIVACY_COPY_FILES = [
  "app/page.tsx",
  "app/(app)/chat/page.tsx",
  "app/(app)/settings/models/page.tsx",
  "app/gate/page.tsx",
  "app/(auth)/sign-in/page.tsx",
  "app/(auth)/sign-up/page.tsx",
  "app/privacy/page.tsx",
  "app/terms/page.tsx",
  "app/transparency/page.tsx",
  "src/components/local-ai/SettingsEcoTab.tsx",
];

const PUBLIC_SHELL_BANNED_METADATA_PATTERNS = [
  /decentralized AI inference/i,
  /powered by the community/i,
  /desktop app/i,
  /governance/i,
  /contributor rewards/i,
  /founding miners/i,
];

describe("public trust and coming-later surfaces", () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams();
  });

  it("public navigation keeps only chat and trust destinations", () => {
    render(<PublicNav />);

    expect(
      screen
        .getAllByRole("link", { name: /start chatting/i })
        .every((link) => link.getAttribute("href") === "/chat"),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("link", { name: "Impact" })
        .every((link) => link.getAttribute("href") === "/impact"),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("link", { name: "Transparency" })
        .every((link) => link.getAttribute("href") === "/transparency"),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("link", { name: "Privacy" })
        .every((link) => link.getAttribute("href") === "/privacy"),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("link", { name: "Terms" })
        .every((link) => link.getAttribute("href") === "/terms"),
    ).toBe(true);

    expect(screen.queryByText("Download Eco")).not.toBeInTheDocument();
    expect(screen.queryByText("Developers")).not.toBeInTheDocument();
    expect(screen.queryByText("Governance")).not.toBeInTheDocument();
    expect(screen.queryByText("Founding Contributors")).not.toBeInTheDocument();
  });

  it("public footer keeps trust pages reachable without retired funnels", () => {
    render(<PublicFooter />);

    expect(screen.getByRole("link", { name: /^chat$/i })).toHaveAttribute(
      "href",
      "/chat",
    );
    expect(screen.getByRole("link", { name: "Impact" })).toHaveAttribute(
      "href",
      "/impact",
    );
    expect(screen.getByRole("link", { name: "Transparency" })).toHaveAttribute(
      "href",
      "/transparency",
    );
    expect(
      screen.getByRole("link", { name: /privacy policy/i }),
    ).toHaveAttribute("href", "/privacy");
    expect(
      screen.getByRole("link", { name: /terms of service/i }),
    ).toHaveAttribute("href", "/terms");

    expect(screen.queryByText("Download Eco")).not.toBeInTheDocument();
    expect(screen.queryByText("Developers")).not.toBeInTheDocument();
    expect(screen.queryByText("Governance")).not.toBeInTheDocument();
  });

  it("privacy page keeps impact, legal siblings, and chat home reachable", () => {
    render(<PrivacyPage />);

    expect(screen.getByRole("link", { name: /start chatting/i })).toHaveAttribute(
      "href",
      "/chat",
    );
    expect(screen.getAllByRole("link", { name: "Impact" }).length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("link", { name: /transparency/i }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("link", { name: /terms of service/i }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("link", { name: /^chat$/i }).length,
    ).toBeGreaterThan(0);
  });

  it("trust pages expose a main landmark and page heading", () => {
    const pages = [
      { Component: PrivacyPage, heading: "Privacy Policy" },
      { Component: TermsPage, heading: "Terms of Service" },
      { Component: TransparencyPage, heading: "Transparency" },
      { Component: ImpactPage, heading: "Our Impact" },
    ];

    for (const { Component, heading } of pages) {
      const { unmount } = render(<Component />);

      expect(screen.getByRole("main")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { level: 1, name: heading }),
      ).toBeInTheDocument();

      unmount();
    }
  });

  it("privacy page limits active guarantees to on-device, browser-local truth", () => {
    const { container } = render(<PrivacyPage />);
    const text = renderedText(container);

    expect(text).toMatch(/web v1\.0/i);
    // The AI model runs in the user's browser; conversations are not sent for inference.
    expect(text).toMatch(/the AI model runs in your browser/i);
    expect(text).toMatch(/not sent to Eco servers for inference/i);
    // Conversation content is never collected.
    expect(text).toMatch(/Your conversation content/i);
    // Local conversations stay on device and can be cleared.
    expect(text).toMatch(/stays on your device/i);
    expect(text).toMatch(/clear it from your browser at any time/i);

    for (const pattern of ACTIVE_PRIVACY_OVERCLAIM_PATTERNS) {
      expect(text).not.toMatch(pattern);
    }
  });

  it("privacy page distinguishes essential cookies from browser storage and model cache", () => {
    const { container } = render(<PrivacyPage />);
    const text = renderedText(container);

    expect(
      screen.getByRole("heading", { name: /cookies and local storage/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/a launch-gate cookie when pre-launch access is enabled/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/one-time prompt handoff/i)).toBeInTheDocument();
    expect(screen.getByText(/guest chat context/i)).toBeInTheDocument();
    expect(screen.getByText(/on-device model cache state/i)).toBeInTheDocument();
    expect(
      screen.getAllByText(/model file names/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/support report that stays in/i)).toBeInTheDocument();
    // Pins the claims the support report must keep true (capture.ts redacts at export).
    expect(text).toMatch(/error messages and stack traces the runtime produced/i);
    expect(text).toMatch(/scrubbed of web addresses and anything that looks like a secret/i);
    expect(text).toMatch(/never contains prompts, generated text, uploaded file contents/i);
    expect(screen.getByText(/do not use tracking cookies/i)).toBeInTheDocument();
  });

  it("terms page keeps impact, privacy, transparency, and chat home reachable", () => {
    render(<TermsPage />);

    expect(screen.getByRole("link", { name: /start chatting/i })).toHaveAttribute(
      "href",
      "/chat",
    );
    expect(
      screen.getAllByRole("link", { name: /privacy policy/i }).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Impact" }).length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("link", { name: /transparency/i }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("link", { name: /^chat$/i }).length,
    ).toBeGreaterThan(0);
  });

  it("terms page describes only launch-active on-device, browser-local behavior", () => {
    const { container } = render(<TermsPage />);
    const text = renderedText(container);

    expect(text).toMatch(/Browser-local AI/i);
    // The AI runs on the user's device; conversations are not sent for inference.
    expect(text).toMatch(/The AI model runs\s+on your device, inside your browser/i);
    expect(text).toMatch(/not sent to Eco servers for inference/i);
    // Model downloads are separate from chat prompts, which stay on device.
    expect(text).toMatch(
      /these downloads are separate from your chat prompts, which\s+stay on your device during inference/i,
    );

    for (const pattern of ACTIVE_PRIVACY_OVERCLAIM_PATTERNS) {
      expect(text).not.toMatch(pattern);
    }
  });

  it("transparency page keeps privacy, terms, impact, and chat home reachable", () => {
    render(<TransparencyPage />);

    expect(screen.getByRole("link", { name: /start chatting/i })).toHaveAttribute(
      "href",
      "/chat",
    );
    expect(
      screen.getAllByRole("link", { name: /privacy policy/i }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("link", { name: /terms of service/i }).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Impact" }).length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("link", { name: /^chat$/i }).length,
    ).toBeGreaterThan(0);
  });

  it("transparency page does not market future network privacy as active", () => {
    const { container } = render(<TransparencyPage />);
    const text = renderedText(container);

    expect(text).toMatch(/Eco web v1\.0/i);
    // The AI runs on the user's device in the browser; not sent for inference.
    expect(text).toMatch(/runs the AI model on your device, inside your browser/i);
    expect(text).toMatch(/not sent to Eco servers for inference/i);
    // Model setup downloads only file names — not conversation egress.
    expect(text).toMatch(/model file names, never your conversation/i);
    // Deleted-vision network/tier privacy copy must not reappear.
    expect(text).not.toMatch(/encrypted transport/i);
    expect(text).not.toMatch(/future Eco Network privacy/i);

    for (const pattern of ACTIVE_PRIVACY_OVERCLAIM_PATTERNS) {
      expect(text).not.toMatch(pattern);
    }
  });

  it("active launch copy files do not contain contradictory network privacy guarantees", () => {
    const findings = ACTIVE_PRIVACY_COPY_FILES.flatMap((relativePath) => {
      const source = fs.readFileSync(path.join(WEB_ROOT, relativePath), "utf8");
      return ACTIVE_PRIVACY_OVERCLAIM_PATTERNS.flatMap((pattern) => {
        const matches = source.match(pattern);
        return matches ? [`${relativePath}: ${pattern.source}`] : [];
      });
    });

    expect(findings).toEqual([]);
  });

  it("public trust surfaces return to the current app route when returnTo is present", () => {
    mockSearchParams = new URLSearchParams("returnTo=%2Fsettings%3Ftab%3Dappearance");

    render(<PublicNav />);
    render(<PublicFooter />);

    expect(screen.getAllByRole("link", { name: /start chatting/i })[0]).toHaveAttribute(
      "href",
      "/settings?tab=appearance",
    );
    expect(screen.getByRole("link", { name: /^chat$/i })).toHaveAttribute(
      "href",
      "/settings?tab=appearance",
    );

    mockSearchParams = new URLSearchParams();
  });

  it("metadata and manifest describe the web v1.0 browser chat launch truth", () => {
    const rootDescription = String(rootMetadata.description ?? "");
    const webManifest = manifest();

    expect(rootMetadata.title).toMatch(/AI that respects you and the planet/i);
    expect(rootDescription).toMatch(/runs on your device, in your browser/i);
    expect(rootDescription).not.toMatch(/Eco Network/i);
    expect(webManifest.description).toMatch(/runs on your device, in your browser/i);
    expect(webManifest.description).not.toMatch(/Eco Network/i);

    const searchableShellCopy = [
      rootMetadata.title,
      rootMetadata.description,
      webManifest.name,
      webManifest.short_name,
      webManifest.description,
    ]
      .filter(Boolean)
      .join(" ");

    for (const pattern of PUBLIC_SHELL_BANNED_METADATA_PATTERNS) {
      expect(searchableShellCopy).not.toMatch(pattern);
    }
  });

  it("404 and global error recovery route users back to browser chat", () => {
    render(<NotFound />);

    expect(
      screen.getByRole("heading", { name: /wandered off the trail/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to chat/i })).toHaveAttribute(
      "href",
      "/chat",
    );

    const reset = vi.fn();
    render(<GlobalError error={new Error("boom")} reset={reset} />);

    expect(
      screen.getByRole("heading", { name: /something tripped us up/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open browser chat/i })).toHaveAttribute(
      "href",
      "/chat",
    );
  });
});
