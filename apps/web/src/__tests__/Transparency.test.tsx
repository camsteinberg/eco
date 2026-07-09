// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// -- Mock next/link ----------------------------------------------------------

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

// -- Mock EcoLogo ------------------------------------------------------------

vi.mock("../../src/components/EcoLogo", () => ({
  EcoLogo: ({ size }: { size: string }) => (
    <div data-testid="eco-logo" data-size={size}>
      Logo
    </div>
  ),
}));

// -- Tests -------------------------------------------------------------------

describe("TransparencyPage", () => {
  const renderPage = async () => {
    const mod = await import("../../app/transparency/page");
    const TransparencyPage = mod.default;
    return render(<TransparencyPage />);
  };

  it("renders page title 'Transparency'", async () => {
    await renderPage();
    expect(
      screen.getByRole("heading", { name: "Transparency" }),
    ).toBeDefined();
  });

  it("renders 'Our Commitment' section heading", async () => {
    await renderPage();
    expect(screen.getByText("Our Commitment")).toBeDefined();
  });

  it("renders 'How Eco Works' section", async () => {
    await renderPage();
    expect(screen.getByText("How Eco Works")).toBeDefined();
  });

  it("renders 'On-Device Inference' section", async () => {
    await renderPage();
    expect(screen.getByText("On-Device Inference")).toBeDefined();
  });

  it("renders on-device privacy truth without future network privacy claims", async () => {
    const { container } = await renderPage();
    const text = container.textContent?.replace(/\s+/g, " ").trim() ?? "";
    // The AI runs in the browser — conversation content stays on device.
    expect(
      screen.getByText(/Your conversation stays on your device/i),
    ).toBeDefined();
    expect(screen.getByText(/You control local storage/i)).toBeDefined();
    // Model downloads carry only file names, not conversation content.
    expect(text).toMatch(/model file names, never your conversation/i);
    // Deleted-vision network/tier privacy copy must not reappear.
    expect(screen.queryByText("Encrypted transport")).toBeNull();
    expect(screen.queryByText("Future Eco Network privacy")).toBeNull();
    expect(text).not.toMatch(/not selectable in web v1\.0/i);
    expect(text).not.toMatch(/encrypted end-to-end/i);
    expect(text).not.toMatch(/hardware-protected enclave/i);
  });

  it("renders 'What We Can See' section", async () => {
    await renderPage();
    expect(screen.getByText("What We Can See")).toBeDefined();
  });

  it("renders Eco operator visibility section", async () => {
    await renderPage();
    expect(screen.getByText("What Eco Operators Cannot See")).toBeDefined();
  });

  it("renders 'The Code' section with AGPL-3.0 reference", async () => {
    await renderPage();
    expect(screen.getByText("The Code")).toBeDefined();
    // AGPL-3.0 appears in multiple sections (Our Commitment + The Code)
    expect(screen.getAllByText(/AGPL-3.0/).length).toBeGreaterThanOrEqual(1);
  });

  it("renders 'Infrastructure' section", async () => {
    await renderPage();
    expect(screen.getByText("Infrastructure")).toBeDefined();
  });

  it("renders 'Contact' section", async () => {
    await renderPage();
    expect(screen.getByText("Contact")).toBeDefined();
  });

  it("renders footer links to /terms and /privacy", async () => {
    await renderPage();

    const termsLink = screen.getByText("Terms of Service");
    expect(termsLink.closest("a")?.getAttribute("href")).toBe("/terms");

    const privacyLink = screen.getByText("Privacy Policy");
    expect(privacyLink.closest("a")?.getAttribute("href")).toBe("/privacy");
  });

  it("uses --eco-* tokens, not --color-* tokens", async () => {
    const { container } = await renderPage();
    const html = container.innerHTML;
    // Verify no legacy --color-* token usage
    expect(html).not.toContain("--color-surface");
    expect(html).not.toContain("--color-primary");
    expect(html).not.toContain("--color-text-primary");
    expect(html).not.toContain("--color-text-secondary");
    expect(html).not.toContain("--color-border");
    // Verify --eco-* tokens are present
    expect(html).toContain("--eco-surface");
    expect(html).toContain("--eco-text");
    expect(html).toContain("--eco-primary");
  });

  it("links to GitHub repository", async () => {
    await renderPage();
    const githubLink = screen.getByText("View on GitHub");
    expect(githubLink.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/camsteinberg/eco"
    );
  });
});

// -- Smoke tests for /terms and /privacy pages --------------------------------

describe("Legal pages smoke tests", () => {
  it("/terms page exports a default function", async () => {
    const mod = await import("../../app/terms/page");
    expect(typeof mod.default).toBe("function");
  });

  it("/privacy page exports a default function", async () => {
    const mod = await import("../../app/privacy/page");
    expect(typeof mod.default).toBe("function");
  });
});
