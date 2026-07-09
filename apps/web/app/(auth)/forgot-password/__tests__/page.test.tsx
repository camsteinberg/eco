// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ForgotPasswordPage from "../page";

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

describe("ForgotPasswordPage", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams();
    global.fetch = vi.fn() as typeof fetch;
  });

  it("validates email accessibly before requesting a reset link", async () => {
    render(<ForgotPasswordPage />);

    const submit = screen.getByRole("button", { name: /send reset link/i });
    expect(submit.closest("form")).toHaveAttribute("novalidate");

    fireEvent.click(submit);

    expect(await screen.findByRole("alert")).toHaveTextContent("Email is required");
    expect(screen.getByLabelText("Email")).toHaveFocus();
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("shows recoverable error feedback without losing the typed email", async () => {
    vi.mocked(global.fetch).mockResolvedValue({ ok: false } as Response);

    render(<ForgotPasswordPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "friend@eco.local" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send reset link/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to send reset email",
    );
    expect(screen.getByLabelText("Email")).toHaveValue("friend@eco.local");
    expect(screen.getByRole("button", { name: /send reset link/i })).not.toBeDisabled();
  });

  it("shows success plus sign-in and local-chat recovery paths", async () => {
    searchParams = new URLSearchParams({
      callbackUrl: "/chat",
      prompt: "Keep this local",
    });
    vi.mocked(global.fetch).mockResolvedValue({ ok: true } as Response);

    render(<ForgotPasswordPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "friend@eco.local" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send reset link/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "friend@eco.local",
          // Absolute: the emailed link's redirect resolves relative URLs
          // against the API origin, which has no /reset-password page.
          redirectTo: new URL(
            "/reset-password?callbackUrl=%2Fchat&prompt=Keep+this+local",
            window.location.origin,
          ).toString(),
        }),
      });
    });

    expect(screen.getByRole("status")).toHaveTextContent(/check your email/i);
    expect(screen.getByRole("link", { name: /back to sign in/i })).toHaveAttribute(
      "href",
      "/sign-in?callbackUrl=%2Fchat&prompt=Keep+this+local",
    );
    expect(screen.getByRole("link", { name: /continue to local chat/i })).toHaveAttribute(
      "href",
      "/chat?prompt=Keep+this+local",
    );
  });
});
