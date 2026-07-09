// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ResetPasswordPage from "../page";

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

describe("ResetPasswordPage", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams({ token: "reset-token" });
    global.fetch = vi.fn() as typeof fetch;
  });

  it("shows a dedicated tokenless state with no password form to nowhere", async () => {
    searchParams = new URLSearchParams({
      callbackUrl: "/chat",
      prompt: "Keep this local",
    });

    const { container } = render(<ResetPasswordPage />);

    expect(
      await screen.findByRole("heading", { name: /this reset link isn't valid/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/this link is incomplete/i);

    // No dead-end form: the doomed password fields (and their pristine coral ring)
    // are gone entirely, so nothing can render aria-invalid on first paint.
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Confirm password")).not.toBeInTheDocument();
    expect(container.querySelector("[aria-invalid]")).toBeNull();

    expect(screen.getByRole("link", { name: /request a new link/i })).toHaveAttribute(
      "href",
      "/forgot-password?callbackUrl=%2Fchat&prompt=Keep+this+local",
    );
    expect(screen.getByRole("link", { name: /back to sign in/i })).toHaveAttribute(
      "href",
      "/sign-in?callbackUrl=%2Fchat&prompt=Keep+this+local",
    );
  });

  it("explains expired links distinctly when Better Auth redirects with ?error", async () => {
    searchParams = new URLSearchParams({
      error: "INVALID_TOKEN",
      callbackUrl: "/chat",
    });

    const { container } = render(<ResetPasswordPage />);

    expect(
      await screen.findByRole("heading", { name: /this reset link isn't valid/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/only last an hour/i);
    expect(screen.queryByText(/this link is incomplete/i)).not.toBeInTheDocument();

    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(container.querySelector("[aria-invalid]")).toBeNull();

    // callbackUrl=/chat is the default and is omitted from recovery hrefs.
    expect(screen.getByRole("link", { name: /request a new link/i })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("renders the password form when the link carries a token", async () => {
    render(<ResetPasswordPage />);

    expect(
      await screen.findByRole("heading", { name: /set new password/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm password")).toBeInTheDocument();
    // A token-present field is not pre-flagged — the ring is error-gated only.
    expect(screen.getByLabelText("New password")).toHaveAttribute("aria-invalid", "false");
  });

  it("validates password fields accessibly before calling reset", async () => {
    render(<ResetPasswordPage />);

    const submit = screen.getByRole("button", { name: /reset password/i });
    expect(submit.closest("form")).toHaveAttribute("novalidate");

    fireEvent.click(submit);

    expect(await screen.findByRole("alert")).toHaveTextContent("Password is required");
    expect(screen.getByLabelText("New password")).toHaveFocus();
    expect(screen.getByLabelText("New password")).toHaveAttribute("aria-invalid", "true");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("keeps controls recoverable after a reset failure", async () => {
    vi.mocked(global.fetch).mockResolvedValue({ ok: false } as Response);

    render(<ResetPasswordPage />);

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "newsecret" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "newsecret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /reset password/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to reset password",
    );
    expect(screen.getByRole("button", { name: /reset password/i })).not.toBeDisabled();
    expect(screen.getByRole("link", { name: /request a new link/i })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("submits a valid token and shows sign-in plus local-chat paths on success", async () => {
    searchParams = new URLSearchParams({
      token: "reset-token",
      callbackUrl: "/chat",
      prompt: "Keep this local",
    });
    vi.mocked(global.fetch).mockResolvedValue({ ok: true } as Response);

    render(<ResetPasswordPage />);

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "newsecret" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "newsecret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /reset password/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newPassword: "newsecret",
          token: "reset-token",
        }),
      });
    });

    expect(screen.getByRole("status")).toHaveTextContent(/password has been reset/i);
    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute(
      "href",
      "/sign-in?callbackUrl=%2Fchat&prompt=Keep+this+local",
    );
    expect(screen.getByRole("link", { name: /continue to local chat/i })).toHaveAttribute(
      "href",
      "/chat?prompt=Keep+this+local",
    );
  });
});
