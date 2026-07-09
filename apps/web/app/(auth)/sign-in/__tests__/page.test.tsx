// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import SignInPage from "../page";

const { signInEmailMock, signInSocialMock, useSessionMock } = vi.hoisted(() => ({
  signInEmailMock: vi.fn(),
  signInSocialMock: vi.fn(),
  useSessionMock: vi.fn(),
}));

let searchParams = new URLSearchParams();
const originalLocation = window.location;

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

vi.mock("../../../../src/lib/auth", () => ({
  signIn: {
    email: signInEmailMock,
    social: signInSocialMock,
  },
  useSession: useSessionMock,
}));

describe("SignInPage", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams({
      callbackUrl: "/chat",
      prompt: "Keep this local",
    });
    useSessionMock.mockReturnValue({ data: null, isPending: false });
    signInEmailMock.mockReset();
    signInSocialMock.mockReset();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...originalLocation,
        origin: "https://eco.local",
        href: "https://eco.local/sign-in?callbackUrl=%2Fchat&prompt=Keep+this+local",
        replace: vi.fn(),
      },
    });
  });

  afterEach(() => {
    sessionStorage.clear();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
    vi.restoreAllMocks();
  });

  it("keeps passive supporter billing links out of the default sign-in flow", () => {
    render(<SignInPage />);

    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: /welcome back/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /sign in and open billing next/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/want supporter membership/i)).not.toBeInTheDocument();
  });

  it("surfaces the supporter continuation note when billing is the callback target", () => {
    searchParams = new URLSearchParams({
      callbackUrl: "/settings?tab=billing",
    });

    render(<SignInPage />);

    expect(
      screen.getByText(/sign in and we'll open billing next so you can manage supporter membership/i),
    ).toBeInTheDocument();
  });

  it("offers a direct guest path back to chat with the pending prompt", () => {
    render(<SignInPage />);

    expect(screen.getByRole("link", { name: /continue as guest/i })).toHaveAttribute(
      "href",
      "/chat?prompt=Keep+this+local",
    );
    expect(screen.getByRole("link", { name: /forgot password/i })).toHaveAttribute(
      "href",
      "/forgot-password?callbackUrl=%2Fchat&prompt=Keep+this+local",
    );
    expect(screen.getByText(/no account needed/i)).toBeInTheDocument();
  });

  it("keeps the compact password visibility control at the 44px touch target baseline", () => {
    render(<SignInPage />);

    expect(screen.getByLabelText("Show password")).toHaveClass(
      "min-h-11",
      "min-w-11",
    );
  });

  it("explains the signed-out state without trapping users on auth", () => {
    searchParams = new URLSearchParams({
      signedOut: "1",
      callbackUrl: "/chat",
    });

    render(<SignInPage />);

    expect(screen.getByText(/you're signed out/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /continue as guest/i })).toHaveAttribute(
      "href",
      "/chat",
    );
  });

  it("validates fields accessibly before calling auth", async () => {
    render(<SignInPage />);

    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText("Email is required")).toBeInTheDocument();
    expect(screen.getByText("Password is required")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveFocus();
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    expect(signInEmailMock).not.toHaveBeenCalled();
  });

  it("maps invalid credentials to actionable copy with an inline reset link, keeping typed email", async () => {
    signInEmailMock.mockResolvedValue({
      error: {
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
      },
    });

    render(<SignInPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "friend@eco.local" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      /that email or password doesn't match\. try again, or reset your password\./i,
    );
    // The raw API string is never shown.
    expect(alert).not.toHaveTextContent(/invalid email or password/i);
    // "reset your password" is a real link that preserves callback + prompt.
    expect(
      within(alert).getByRole("link", { name: /reset your password/i }),
    ).toHaveAttribute(
      "href",
      "/forgot-password?callbackUrl=%2Fchat&prompt=Keep+this+local",
    );
    expect(screen.getByLabelText("Email")).toHaveValue("friend@eco.local");
    expect(screen.getByRole("button", { name: /sign in/i })).not.toBeDisabled();
  });

  it("shows warm generic copy (never a bland 'Sign in failed') for an unexpected sign-in error", async () => {
    // better-auth can return an empty message with an unrecognized code — the
    // old `?? "Sign in failed"` fallback fired here. Map by code, warm generic.
    signInEmailMock.mockResolvedValue({
      error: { code: "INTERNAL_SERVER_ERROR", message: "" },
    });

    render(<SignInPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "friend@eco.local" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "whatever" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Something went wrong signing you in. Please try again.",
    );
    expect(alert).not.toHaveTextContent(/sign in failed/i);
  });

  it("restores sanitized chat continuation once after successful credential sign-in", async () => {
    signInEmailMock.mockResolvedValue({ error: null });

    render(<SignInPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "friend@eco.local" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await screen.findByRole("button", { name: /sign in/i });

    expect(signInEmailMock).toHaveBeenCalledWith({
      email: "friend@eco.local",
      password: "correct-horse",
      callbackURL: "https://eco.local/chat",
    });
    expect(sessionStorage.getItem("eco-pending-chat-prompt")).toBe("Keep this local");
    expect(window.location.href).toBe("/chat");
  });

  it("collapses unsafe credential sign-in callbacks while preserving guest prompt context", async () => {
    searchParams = new URLSearchParams({
      callbackUrl: "/api/admin/economy",
      prompt: "Keep this local",
    });
    signInEmailMock.mockResolvedValue({ error: null });

    render(<SignInPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "friend@eco.local" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await screen.findByRole("button", { name: /sign in/i });

    expect(sessionStorage.getItem("eco-pending-chat-prompt")).toBe("Keep this local");
    expect(window.location.href).toBe("/chat");
  });

  it("models the local password-reset fixture where old password fails and new password signs in", async () => {
    signInEmailMock
      .mockResolvedValueOnce({
        error: {
          code: "INVALID_EMAIL_OR_PASSWORD",
          message: "Invalid email or password",
        },
      })
      .mockResolvedValueOnce({ error: null });

    render(<SignInPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "reset-fixture@eco.local" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "old-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /that email or password doesn't match/i,
    );
    expect(screen.getByLabelText("Email")).toHaveValue("reset-fixture@eco.local");

    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "new-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await screen.findByRole("button", { name: /sign in/i });

    expect(signInEmailMock).toHaveBeenNthCalledWith(1, {
      email: "reset-fixture@eco.local",
      password: "old-password",
      callbackURL: "https://eco.local/chat",
    });
    expect(signInEmailMock).toHaveBeenNthCalledWith(2, {
      email: "reset-fixture@eco.local",
      password: "new-password",
      callbackURL: "https://eco.local/chat",
    });
    expect(window.location.href).toBe("/chat");
  });

  it("explains the unverified-email block and the fresh link instead of a raw API error", async () => {
    signInEmailMock.mockResolvedValue({
      error: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" },
    });

    render(<SignInPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "friend@eco.local" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /isn't verified yet.*fresh verification link/i,
    );
    expect(screen.getByLabelText("Email")).toHaveValue("friend@eco.local");
    expect(screen.getByRole("button", { name: /sign in/i })).not.toBeDisabled();
  });
});
