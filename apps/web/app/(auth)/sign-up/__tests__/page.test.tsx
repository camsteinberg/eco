// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import SignUpPage from "../page";

const { signInSocialMock, signUpEmailMock, useSessionMock } = vi.hoisted(() => ({
  signInSocialMock: vi.fn(),
  signUpEmailMock: vi.fn(),
  useSessionMock: vi.fn(),
}));
let searchParams = new URLSearchParams();

const originalGoogleEnabled = process.env.NEXT_PUBLIC_OAUTH_GOOGLE_ENABLED;
const originalGithubEnabled = process.env.NEXT_PUBLIC_OAUTH_GITHUB_ENABLED;
const originalLocation = window.location;

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

vi.mock("../../../../src/lib/auth", () => ({
  signIn: {
    social: signInSocialMock,
  },
  signUp: {
    email: signUpEmailMock,
  },
  useSession: useSessionMock,
}));

let mockBillingUiEnabled = false;
vi.mock("../../../../src/lib/billing-ui-gate", () => ({
  isBillingUiEnabled: () => mockBillingUiEnabled,
}));

describe("SignUpPage", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams({
      callbackUrl: "/chat",
      prompt: "Keep this local",
    });
    sessionStorage.clear();

    process.env.NEXT_PUBLIC_OAUTH_GOOGLE_ENABLED = "true";
    process.env.NEXT_PUBLIC_OAUTH_GITHUB_ENABLED = "false";

    useSessionMock.mockReturnValue({ data: null, isPending: false });
    signInSocialMock.mockReset();
    signUpEmailMock.mockReset();
    mockBillingUiEnabled = false;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as typeof fetch;

    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...originalLocation,
        origin: "https://eco.local",
        href: "https://eco.local/sign-up?callbackUrl=%2Fchat&prompt=Keep+this+local",
        replace: vi.fn(),
      },
    });
  });

  afterEach(() => {
    if (originalGoogleEnabled === undefined) {
      delete process.env.NEXT_PUBLIC_OAUTH_GOOGLE_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_OAUTH_GOOGLE_ENABLED = originalGoogleEnabled;
    }

    if (originalGithubEnabled === undefined) {
      delete process.env.NEXT_PUBLIC_OAUTH_GITHUB_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_OAUTH_GITHUB_ENABLED = originalGithubEnabled;
    }

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
    vi.restoreAllMocks();
  });

  it("renders the open sign-up form without an invite gate", () => {
    render(<SignUpPage />);

    expect(
      screen.getByRole("heading", { name: /create your account/i }),
    ).toBeInTheDocument();
    // No invite validation request is made on render.
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/v1/referrals/validate"),
    );
    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it("creates an account with email and password without requiring an invite", async () => {
    signUpEmailMock.mockResolvedValue({ error: null });

    render(<SignUpPage />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Eco Fixture" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "fixture@eco.local" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      // callbackURL must be absolute: it lands in the verification email's
      // post-verify redirect, which resolves relative URLs on the API origin.
      expect(signUpEmailMock).toHaveBeenCalledWith({
        name: "Eco Fixture",
        email: "fixture@eco.local",
        password: "correct-horse",
        callbackURL: "https://eco.local/chat",
      });
    });

    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/v1/referrals/validate"),
    );
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/v1/billing"),
      expect.anything(),
    );
    expect(sessionStorage.getItem("eco-pending-chat-prompt")).toBe("Keep this local");
    expect(window.location.href).toBe("/chat");
  });

  it("preserves the auth callback for OAuth sign-up without invite validation", async () => {
    render(<SignUpPage />);

    fireEvent.click(screen.getByRole("button", { name: /continue with google/i }));

    await waitFor(() => {
      expect(signInSocialMock).toHaveBeenCalledWith({
        provider: "google",
        callbackURL: "https://eco.local/chat",
      });
    });

    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/v1/referrals/validate"),
    );
    expect(sessionStorage.getItem("eco-pending-chat-prompt")).toBe("Keep this local");
  });

  it("redirects authenticated sessions to the sanitized callback target", async () => {
    searchParams = new URLSearchParams({
      callbackUrl: "/settings?tab=account",
    });
    useSessionMock.mockReturnValue({
      data: { user: { id: "user-1" } },
      isPending: false,
    });

    render(<SignUpPage />);

    await waitFor(() => {
      expect(window.location.replace).toHaveBeenCalledWith("/settings?tab=account");
    });
  });

  it("keeps the sign-up form visible when the auth client reports an empty session payload", async () => {
    useSessionMock.mockReturnValue({
      data: { session: null, user: null },
      isPending: false,
    });

    render(<SignUpPage />);

    expect(await screen.findByRole("heading", { name: /create your account/i })).toBeInTheDocument();
    expect(window.location.replace).not.toHaveBeenCalledWith("/chat");
  });

  it("renders inline validation errors for blank submits", async () => {
    searchParams = new URLSearchParams();

    render(<SignUpPage />);

    const submitButton = screen.getByRole("button", { name: /create account/i });
    const form = submitButton.closest("form");

    expect(form).toHaveAttribute("novalidate");

    fireEvent.click(submitButton);

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(screen.getByText("Email is required")).toBeInTheDocument();
    expect(screen.getByText("Password is required")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(signUpEmailMock).not.toHaveBeenCalled();
  });

  it("keeps auth layout compact on mobile while preserving desktop cookie banner space", () => {
    const { container } = render(<SignUpPage />);

    expect(container.firstElementChild).toHaveClass(
      "items-start",
      "overflow-y-auto",
      "pb-6",
      "pt-4",
      "sm:items-center",
      "sm:pb-28",
      "sm:pt-12",
    );
  });

  it("keeps compact mobile icon controls at the 44px touch target baseline", () => {
    render(<SignUpPage />);

    expect(screen.getByLabelText("Go to homepage")).toHaveClass(
      "min-h-11",
      "min-w-11",
    );
    expect(screen.getByLabelText("Show password")).toHaveClass(
      "min-h-11",
      "min-w-11",
    );
  });

  it("shows an inline invalid-email error before submit reaches auth", async () => {
    searchParams = new URLSearchParams();

    render(<SignUpPage />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Eco Tester" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "not-an-email" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
    expect(signUpEmailMock).not.toHaveBeenCalled();
  });

  it("shows an inline short-password error and focuses the password field", async () => {
    searchParams = new URLSearchParams();

    render(<SignUpPage />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Eco Tester" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "eco@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(
      await screen.findByText("Password must be at least 8 characters"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveFocus();
    expect(signUpEmailMock).not.toHaveBeenCalled();
  });

  it("discloses a duplicate email with an inline 'Sign in instead?' link", async () => {
    signUpEmailMock.mockResolvedValue({
      error: {
        code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
        message: "User already exists. Use another email.",
      },
    });

    render(<SignUpPage />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Eco Fixture" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "taken@eco.local" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      /an account with this email already exists\./i,
    );
    expect(alert).not.toHaveTextContent(/sign up failed/i);
    expect(
      within(alert).getByRole("link", { name: /sign in instead/i }),
    ).toHaveAttribute(
      "href",
      "/sign-in?callbackUrl=%2Fchat&prompt=Keep+this+local",
    );
  });

  it("preserves a code-less signup-policy rejection message (disposable-email guard)", async () => {
    // Our signup hook throws APIError with a crafted, user-facing message and NO
    // code — it must survive, not collapse to the warm generic.
    signUpEmailMock.mockResolvedValue({
      error: {
        message:
          "Please use a permanent email address — disposable email providers aren’t supported.",
      },
    });

    render(<SignUpPage />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Eco Fixture" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "bot@mailinator.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /disposable email providers aren’t supported/i,
    );
  });

  it("shows warm generic copy (never a bland 'Sign up failed') for an unexpected error", async () => {
    signUpEmailMock.mockResolvedValue({
      error: { code: "INTERNAL_SERVER_ERROR", message: "" },
    });

    render(<SignUpPage />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Eco Fixture" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "fixture@eco.local" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Something went wrong creating your account. Please try again.",
    );
    expect(alert).not.toHaveTextContent(/sign up failed/i);
  });

  it("preserves callback and prompt intent in the sign-in link", () => {
    render(<SignUpPage />);

    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute(
      "href",
      "/sign-in?callbackUrl=%2Fchat&prompt=Keep+this+local",
    );
  });

  it("offers a guest path back to chat without requiring account creation", () => {
    render(<SignUpPage />);

    expect(screen.getByRole("link", { name: /continue as guest/i })).toHaveAttribute(
      "href",
      "/chat?prompt=Keep+this+local",
    );
    expect(screen.getByText(/create an account anytime/i)).toBeInTheDocument();
  });

  it("hides the supporter continuation note when billing UI is disabled", () => {
    searchParams = new URLSearchParams({
      callbackUrl: "/settings?tab=billing",
    });

    render(<SignUpPage />);

    expect(screen.queryByText(/supporter membership/i)).not.toBeInTheDocument();
  });

  it("surfaces the supporter continuation note when billing UI is enabled", () => {
    mockBillingUiEnabled = true;
    searchParams = new URLSearchParams({
      callbackUrl: "/settings?tab=billing",
    });

    render(<SignUpPage />);

    expect(screen.getByText(/create your account and we'll open billing next/i)).toBeInTheDocument();
  });

  it("keeps passive supporter billing links out of the default sign-up flow", () => {
    searchParams = new URLSearchParams({
      prompt: "Keep this local",
    });

    render(<SignUpPage />);

    expect(
      screen.queryByRole("link", { name: /create your account and open billing next/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/want to support eco from day one/i)).not.toBeInTheDocument();
  });
});
