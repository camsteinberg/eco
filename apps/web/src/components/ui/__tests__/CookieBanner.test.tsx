// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { CookieBanner } from "../CookieBanner";

const COOKIE_KEY = "eco-cookie-consent-dismissed";
const RESERVE_CLASS = "eco-chat-cookie-notice";
const PAGE_RESERVE_CLASS = "eco-page-cookie-notice";

describe("CookieBanner", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    // The reserve flags live on <html>; clear them so they can't leak between
    // cases (RTL unmount already runs the effect cleanup, but be explicit).
    document.documentElement.classList.remove(RESERVE_CLASS);
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

  it("positions away from chat composer send controls", () => {
    window.history.replaceState({}, "", "/chat");
    render(<CookieBanner />);
    const banner = screen.getByRole("status");
    // Mobile: anchored just above the safe-area-inset (slim bar). sm+: lifts
    // above the legacy chat composer height. lg: docks to bottom-right.
    expect(banner).toHaveClass("bottom-[calc(0.5rem+env(safe-area-inset-bottom))]");
    expect(banner).toHaveClass("sm:bottom-[calc(5.5rem+env(safe-area-inset-bottom))]");
    expect(banner).toHaveClass("lg:bottom-6", "lg:left-auto");
  });

  it("docks clear of the chat surface's help-button lane", () => {
    // Toast.tsx reserves the same 68px lane at the right edge; docking at
    // lg:right-6 put this card straight over the help button on /chat.
    window.history.replaceState({}, "", "/chat");
    render(<CookieBanner />);
    expect(screen.getByRole("status")).toHaveClass("lg:right-[4.75rem]");
  });

  it("keeps the compact footer placement outside chat", () => {
    render(<CookieBanner />);
    const banner = screen.getByRole("status");
    // Mobile: tighter padding + slimmer anchor. sm+: original footer position.
    expect(banner).toHaveClass("bottom-2");
    expect(banner).toHaveClass("sm:bottom-6", "sm:right-6");
  });

  it("flags <html> to reserve composer space while showing on the chat surface", () => {
    // The fixed notice would otherwise sit over the Send button; the flag lets
    // globals.css lift the composer clear of it (bug: every desktop user, first session).
    window.history.replaceState({}, "", "/chat");
    render(<CookieBanner />);
    expect(document.documentElement).toHaveClass(RESERVE_CLASS);
  });

  it("flags <html> to reserve scroll room while showing outside the chat surface", () => {
    // Content pages have no bottom-anchored chrome to lift, so they simply
    // ended under the notice — the closing lines of the privacy policy could
    // not be read out from under it.
    render(<CookieBanner />);
    expect(document.documentElement).toHaveClass(PAGE_RESERVE_CLASS);
    expect(document.documentElement).not.toHaveClass(RESERVE_CLASS);
  });

  it("uses the chat reserve, not the page reserve, on the chat surface", () => {
    window.history.replaceState({}, "", "/chat");
    render(<CookieBanner />);
    expect(document.documentElement).not.toHaveClass(PAGE_RESERVE_CLASS);
  });

  it("clears the reserve flag when dismissed on the chat surface", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/chat");
    render(<CookieBanner />);
    expect(document.documentElement).toHaveClass(RESERVE_CLASS);

    await user.click(screen.getByRole("button", { name: /dismiss cookie notice/i }));
    expect(document.documentElement).not.toHaveClass(RESERVE_CLASS);
  });

  it("clears the reserve flag when dismissed outside the chat surface", async () => {
    const user = userEvent.setup();
    render(<CookieBanner />);
    expect(document.documentElement).toHaveClass(PAGE_RESERVE_CLASS);

    await user.click(screen.getByRole("button", { name: /dismiss cookie notice/i }));
    expect(document.documentElement).not.toHaveClass(PAGE_RESERVE_CLASS);
  });
});
