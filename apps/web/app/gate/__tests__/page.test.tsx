// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import GatePage from "../page";

const pushMock = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => searchParams,
}));

describe("GatePage", () => {
  beforeEach(() => {
    pushMock.mockReset();
    searchParams = new URLSearchParams();
    global.fetch = vi.fn();
  });

  it("renders password input and submit button", () => {
    render(<GatePage />);
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: /early access/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Access password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enter" })).toBeInTheDocument();
  });

  it("uses CSS variables for input styling (no hardcoded colors)", () => {
    render(<GatePage />);
    const input = screen.getByLabelText("Access password");
    const style = input.getAttribute("style") ?? "";

    // Must use CSS variables, not hardcoded hex
    expect(style).toContain("var(--eco-");
    expect(style).not.toContain("#d4d4d4");
    expect(style).not.toContain("#1a1a1a");
  });

  it("uses CSS variable for button background (no hardcoded green)", () => {
    render(<GatePage />);
    const button = screen.getByRole("button", { name: "Enter" });
    const style = button.getAttribute("style") ?? "";

    expect(style).toContain("var(--eco-primary)");
    expect(style).not.toContain("#1a5c2a");
  });

  it("uses CSS variables for container background and text color", () => {
    render(<GatePage />);
    // The outermost div is the container
    const container = screen.getByLabelText("Access password").closest(
      "form"
    )!.parentElement!;
    const style = container.getAttribute("style") ?? "";

    expect(style).toContain("var(--eco-surface)");
    expect(style).toContain("var(--eco-text)");
    // Should not use fallback values with hardcoded hex
    expect(style).not.toContain("#fafaf8");
    expect(style).not.toContain("var(--color-bg");
    expect(style).not.toContain("var(--color-text,");
  });

  it("returns to the intercepted destination after a successful unlock", async () => {
    searchParams = new URLSearchParams({
      returnTo: "/sign-up?callbackUrl=%2Fchat&prompt=Keep+this+local",
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(<GatePage />);

    fireEvent.change(screen.getByLabelText("Access password"), {
      target: { value: "greenhouse" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(
        "/sign-up?callbackUrl=%2Fchat&prompt=Keep+this+local",
      );
    });
  });

  it("falls back to chat when the return target is unsafe", async () => {
    searchParams = new URLSearchParams({
      returnTo: "https://evil.example/phish",
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(<GatePage />);

    fireEvent.change(screen.getByLabelText("Access password"), {
      target: { value: "greenhouse" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/chat");
    });
  });

  it("does not return to internal or admin route classes", async () => {
    searchParams = new URLSearchParams({
      returnTo: "/api/admin/economy",
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    render(<GatePage />);

    fireEvent.change(screen.getByLabelText("Access password"), {
      target: { value: "greenhouse" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/chat");
    });
  });

  it("restores controls and announces an accessible error after a failed unlock", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });

    render(<GatePage />);

    fireEvent.change(screen.getByLabelText("Access password"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That password isn’t right. Try again.",
    );
    expect(screen.getByRole("button", { name: "Enter" })).not.toBeDisabled();
    expect(screen.getByLabelText("Access password")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("restores controls and announces a recoverable error when gate submit transport fails", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ configured: true }) })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<GatePage />);

    fireEvent.change(screen.getByLabelText("Access password"), {
      target: { value: "greenhouse" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn’t reach the access gate. Check your connection and try again.",
    );
    expect(screen.getByRole("button", { name: "Enter" })).not.toBeDisabled();
    expect(screen.getByLabelText("Access password")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("shows a non-dead-end inactive gate state when SITE_PASSWORD is not configured", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ configured: false }),
    });

    render(<GatePage />);

    expect(
      await screen.findByText(/private launch gate is open right now/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Access password")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /start chat/i })).toHaveAttribute(
      "href",
      "/chat",
    );
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute(
      "href",
      "/terms",
    );
    expect(screen.getByRole("link", { name: "Transparency" })).toHaveAttribute(
      "href",
      "/transparency",
    );
  });
});
