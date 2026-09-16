// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { CookieBanner } from "../CookieBanner";

const COOKIE_KEY = "eco-cookie-consent-dismissed";
const PAGE_RESERVE_CLASS = "eco-page-cookie-notice";

// The banner reads the route from the router, so every case declares one.
let mockPathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

describe("CookieBanner", () => {
  beforeEach(() => {
    localStorage.clear();
    mockPathname = "/";
  });

  afterEach(() => {
    // The reserve flag lives on <html>; clear it so it can't leak between
    // cases (RTL unmount already runs the effect cleanup, but be explicit).
    document.documentElement.classList.remove(PAGE_RESERVE_CLASS);
  });

  it("renders banner when localStorage has no eco-cookie-consent-dismissed key", () => {
    render(<CookieBanner />);
    expect(
      screen.getByText(/only essential cookies and local browser preferences/i)
    ).toBeInTheDocument();
  });

  it("does NOT render when localStorage eco-cookie-consent-dismissed is 'true'", () => {
    localStorage.setItem(COOKIE_KEY, "true");
    render(<CookieBanner />);
    expect(
      screen.queryByText(/only essential cookies and local browser preferences/i)
    ).not.toBeInTheDocument();
  });

  it("clicking dismiss button sets localStorage key and hides the banner", async () => {
    const user = userEvent.setup();
    render(<CookieBanner />);

    const dismissBtn = screen.getByRole("button", { name: /dismiss/i });
    await user.click(dismissBtn);

    expect(localStorage.getItem(COOKIE_KEY)).toBe("true");
    expect(
      screen.queryByText(/only essential cookies and local browser preferences/i)
    ).not.toBeInTheDocument();
  });

  it("banner contains text about cookies and a link to /privacy", () => {
    render(<CookieBanner />);
    expect(
      screen.getByText(/no tracking/i)
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /learn more/i });
    expect(link).toHaveAttribute("href", "/privacy");
  });

  it("banner has role='status' and aria-live='polite'", () => {
    render(<CookieBanner />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("aria-live", "polite");
  });

  it("gives the dismiss control a full-size touch target", () => {
    render(<CookieBanner />);
    const dismissBtn = screen.getByRole("button", { name: /dismiss cookie notice/i });
    expect(dismissBtn).toHaveClass("h-11", "w-11", "items-center", "justify-center");
  });

  it("keeps the compact footer placement outside chat", () => {
    render(<CookieBanner />);
    const banner = screen.getByRole("status");
    // Mobile: tighter padding + slimmer anchor. sm+: original footer position.
    expect(banner).toHaveClass("bottom-2");
    expect(banner).toHaveClass("sm:bottom-6", "sm:right-6");
  });

  it("renders nothing on the chat surface", () => {
    // Chat is bottom-anchored end to end, so a fixed bottom notice lands on a
    // control at some viewport (measured at 1000×740: over the model tiles and
    // the "Start with Eco Deeper" button). It stays off chat entirely.
    mockPathname = "/chat";
    render(<CookieBanner />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders nothing on a chat conversation route", () => {
    mockPathname = "/chat/some-id";
    render(<CookieBanner />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("sets no reserve class on the chat surface", () => {
    mockPathname = "/chat";
    render(<CookieBanner />);
    expect(document.documentElement).not.toHaveClass(PAGE_RESERVE_CLASS);
  });

  it("flags <html> to reserve scroll room while showing outside the chat surface", () => {
    // Content pages have no bottom-anchored chrome to lift, so they simply
    // ended under the notice — the closing lines of the privacy policy could
    // not be read out from under it.
    render(<CookieBanner />);
    expect(document.documentElement).toHaveClass(PAGE_RESERVE_CLASS);
  });

  it("still renders on a content route", () => {
    mockPathname = "/privacy";
    render(<CookieBanner />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(document.documentElement).toHaveClass(PAGE_RESERVE_CLASS);
  });

  it("clears the reserve flag when dismissed outside the chat surface", async () => {
    const user = userEvent.setup();
    render(<CookieBanner />);
    expect(document.documentElement).toHaveClass(PAGE_RESERVE_CLASS);

    await user.click(screen.getByRole("button", { name: /dismiss cookie notice/i }));
    expect(document.documentElement).not.toHaveClass(PAGE_RESERVE_CLASS);
  });
});
