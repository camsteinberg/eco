// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { Suspense, useState, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { signUp, signIn, useSession } from "../../../src/lib/auth";
import { EcoLogo } from "../../../src/components/EcoLogo";
import { Button } from "@eco/ui";
import Link from "next/link";
import {
  buildAuthPageHref,
  resolveAuthSuccessNavigation,
  toAbsoluteWebUrl,
} from "../../../src/lib/auth-continuation";
import { rememberPendingChatPrompt } from "../../../src/lib/pending-chat-prompt";
import {
  isSupporterBillingHref,
} from "../../../src/lib/supporter-membership";

function getEmailError(value: string): string | null {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return "Email is required";
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedValue)) {
    return "Enter a valid email address";
  }

  return null;
}

function buildGuestChatHref(prompt: string | null): string {
  const normalizedPrompt = prompt?.trim();
  if (!normalizedPrompt) {
    return "/chat";
  }

  const params = new URLSearchParams({ prompt: normalizedPrompt });
  return `/chat?${params.toString()}`;
}

// Sign-up errors are mapped by better-auth error CODE, never by parsing the
// message (which arrived empty and fell through to a bland "Sign up failed").
// `duplicate-email` renders an alert with an inline "Sign in instead?" link.
// Enumeration hygiene is deliberately relaxed at signup (ruling R-D7): telling
// someone their email is already registered here is a normal, expected signal.
type SignUpError =
  | { type: "text"; text: string }
  | { type: "duplicate-email" };

const SIGN_UP_GENERIC_ERROR =
  "Something went wrong creating your account. Please try again.";

function SignUpForm() {
  const searchParams = useSearchParams();
  const { data: session, isPending } = useSession();
  const isAuthenticated = Boolean(session?.user);
  const callbackUrl = searchParams.get("callbackUrl");
  const prompt = searchParams.get("prompt");
  const { redirectTo: effectiveCallback, promptToResume } =
    resolveAuthSuccessNavigation(callbackUrl, prompt);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<SignUpError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; email?: string; password?: string }>({});
  const [loading, setLoading] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  const googleEnabled = process.env.NEXT_PUBLIC_OAUTH_GOOGLE_ENABLED === 'true';
  const githubEnabled = process.env.NEXT_PUBLIC_OAUTH_GITHUB_ENABLED === 'true';
  const anyOAuthEnabled = googleEnabled || githubEnabled;
  const signInHref = buildAuthPageHref("/sign-in", { callbackUrl, prompt });
  const supporterIntent = isSupporterBillingHref(callbackUrl);
  const guestChatHref = buildGuestChatHref(promptToResume);

  useEffect(() => {
    if (!isPending && isAuthenticated) {
      if (promptToResume) {
        rememberPendingChatPrompt(promptToResume);
      }
      window.location.replace(effectiveCallback);
    }
  }, [effectiveCallback, isAuthenticated, isPending, promptToResume]);

  if (!isPending && isAuthenticated) {
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    const errors: { name?: string; email?: string; password?: string } = {};
    if (!name.trim()) errors.name = "Name is required";
    const emailError = getEmailError(email);
    if (emailError) errors.email = emailError;
    if (!password) errors.password = "Password is required";
    else if (password.length < 8) errors.password = "Password must be at least 8 characters";
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      if (errors.name) {
        nameInputRef.current?.focus();
      } else if (errors.email) {
        emailInputRef.current?.focus();
      } else if (errors.password) {
        passwordInputRef.current?.focus();
      }
      return;
    }

    setLoading(true);

    try {
      const { error: authError } = await signUp.email({
        name: name.trim(),
        email: email.trim(),
        password,
        // Absolute: this lands in the verification email's post-verify
        // redirect, which would otherwise resolve against the API origin.
        callbackURL: toAbsoluteWebUrl(effectiveCallback),
      });
      if (authError) {
        const code = authError.code;
        if (
          code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" ||
          code === "USER_ALREADY_EXISTS"
        ) {
          setError({ type: "duplicate-email" });
        } else if (
          !code &&
          typeof authError.message === "string" &&
          authError.message.trim().length > 0
        ) {
          // A code-less server message is one of our own crafted signup-policy
          // rejections (e.g. the disposable-email guard, thrown without a code).
          // It's safe, user-facing, and actionable — preserve it. Only opaque or
          // truly unknown failures fall through to the warm generic below.
          setError({ type: "text", text: authError.message });
        } else {
          setError({ type: "text", text: SIGN_UP_GENERIC_ERROR });
        }
      } else {
        if (promptToResume) {
          rememberPendingChatPrompt(promptToResume);
        }
        window.location.href = effectiveCallback;
      }
    } catch {
      setError({ type: "text", text: SIGN_UP_GENERIC_ERROR });
    } finally {
      setLoading(false);
    }
  }

  async function handleOAuth(provider: "google" | "github") {
    try {
      if (promptToResume) {
        rememberPendingChatPrompt(promptToResume);
      }
      await signIn.social({ provider, callbackURL: toAbsoluteWebUrl(effectiveCallback) });
    } catch {
      setError({ type: "text", text: "We couldn't start that sign-up. Please try again." });
    }
  }

  const isBusy = loading;

  return (
    <div className="grain relative flex min-h-dvh items-start justify-center overflow-y-auto overflow-x-hidden bg-[var(--color-surface)] px-4 pb-6 pt-4 sm:items-center sm:overflow-hidden sm:pb-28 sm:pt-12">
      {/* Mountain silhouettes — connects to landing valley */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-80 sm:h-96" aria-hidden="true">
        <svg viewBox="0 0 1440 320" fill="none" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          <path d="M0 320 L0 220 Q120 160 280 200 Q440 140 600 180 Q760 120 920 170 Q1080 110 1240 160 Q1360 130 1440 180 L1440 320Z" fill="var(--color-accent)" opacity="0.08" />
          <path d="M0 320 L0 240 Q180 180 360 210 Q540 160 720 200 Q900 150 1080 190 Q1260 160 1440 210 L1440 320Z" fill="var(--color-accent)" opacity="0.14" />
          <path d="M0 320 L0 270 Q240 230 480 255 Q720 220 960 245 Q1200 225 1440 260 L1440 320Z" fill="var(--color-primary)" opacity="0.20" />
        </svg>
        {/* Scattered leaf accents */}
        <svg className="absolute bottom-20 right-[10%] h-8 w-8 opacity-[0.13] rotate-[20deg]" viewBox="0 0 32 32" fill="none">
          <path d="M7 25C7 25 5.5 16 11 11C16.5 6 25 4.5 28 4.5C28 4.5 29.5 13.5 24 19C18.5 24.5 10 25 7 25Z" fill="var(--color-primary)" />
        </svg>
        <svg className="absolute bottom-28 left-[18%] h-6 w-6 opacity-[0.11] rotate-[-25deg]" viewBox="0 0 32 32" fill="none">
          <path d="M7 25C7 25 5.5 16 11 11C16.5 6 25 4.5 28 4.5C28 4.5 29.5 13.5 24 19C18.5 24.5 10 25 7 25Z" fill="var(--color-primary)" />
        </svg>
        <svg className="absolute bottom-36 left-[42%] h-5 w-5 opacity-[0.10] rotate-[-55deg]" viewBox="0 0 32 32" fill="none">
          <path d="M7 25C7 25 5.5 16 11 11C16.5 6 25 4.5 28 4.5C28 4.5 29.5 13.5 24 19C18.5 24.5 10 25 7 25Z" fill="var(--color-accent)" />
        </svg>
      </div>

      {/* Warm glow behind card */}
      <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full opacity-[0.12]" style={{ background: 'radial-gradient(circle, var(--color-accent) 0%, transparent 70%)' }} aria-hidden="true" />

      <div className="relative z-10 w-full max-w-[28rem]">
        {/* Logo above card */}
        <div className="mb-6 flex justify-center sm:mb-10">
          <Link
            href="/"
            aria-label="Go to homepage"
            className="inline-flex min-h-11 min-w-11 items-center justify-center"
          >
            <EcoLogo size="lg" />
          </Link>
        </div>

        {/* Card */}
        <div className="relative overflow-hidden rounded-2xl border border-[color-mix(in_srgb,var(--color-border),var(--color-accent)_15%)] bg-[var(--color-surface-raised)] p-6 shadow-sm sm:p-12">
          {/* Subtle top light effect on card */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24" style={{ background: 'linear-gradient(to bottom, color-mix(in srgb, var(--color-accent) 6%, transparent), transparent)' }} aria-hidden="true" />

          <h1 className="relative text-center font-serif text-[var(--color-text-primary)]" style={{ fontSize: 'clamp(1.5rem, 1rem + 2.5vw, 2.25rem)' }}>
            Create your account
          </h1>
          <p className="relative mt-2 text-center text-sm text-[var(--color-text-secondary)]">
            Free forever. No credit card required.
          </p>

          {supporterIntent && (
            <div className="relative mt-4 rounded-2xl border border-[color-mix(in_srgb,var(--color-primary),var(--color-border)_55%)] bg-[color-mix(in_srgb,var(--color-primary-soft),white_14%)] px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-primary)]">
                Supporter membership
              </p>
              <p className="mt-1 text-sm leading-6 text-[var(--color-text-secondary)]">
                Create your account and we&apos;ll open Billing next so you can finish supporter membership without hunting for it later.
              </p>
            </div>
          )}

          {/* General error banner */}
          {error && (
            <div
              role="alert"
              className="relative mt-4 rounded-xl px-4 py-2.5 text-sm"
              style={{ backgroundColor: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}
            >
              {error.type === "duplicate-email" ? (
                <>
                  An account with this email already exists.{" "}
                  <Link
                    href={signInHref}
                    className="font-semibold underline underline-offset-2"
                  >
                    Sign in instead?
                  </Link>
                </>
              ) : (
                error.text
              )}
            </div>
          )}

          <form noValidate onSubmit={handleSubmit} className="relative mt-6 space-y-4">
            {/* Name */}
            <div>
              <label
                htmlFor="name"
                className="block text-base font-medium text-[var(--color-text-primary)]"
              >
                Name
              </label>
              <input
                id="name"
                ref={nameInputRef}
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (fieldErrors.name) {
                    setFieldErrors((current) => ({ ...current, name: undefined }));
                  }
                }}
                aria-describedby={fieldErrors.name ? "sign-up-name-error" : undefined}
                aria-invalid={fieldErrors.name ? "true" : "false"}
                autoComplete="name"
                className={`mt-1.5 block w-full rounded-xl border bg-[var(--color-surface)] px-4 py-3 text-base text-[var(--color-text-primary)] placeholder-[var(--color-text-secondary)] transition-all duration-150 ease focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)] ${
                  fieldErrors.name
                    ? "border-[var(--color-danger)]"
                    : "border-[var(--color-border)]"
                }`}
                placeholder="Your name"
              />
              {fieldErrors.name && (
                <p
                  id="sign-up-name-error"
                  className="mt-1 text-xs"
                  role="alert"
                  style={{ color: 'var(--color-danger)' }}
                >
                  {fieldErrors.name}
                </p>
              )}
            </div>

            {/* Email */}
            <div>
              <label
                htmlFor="email"
                className="block text-base font-medium text-[var(--color-text-primary)]"
              >
                Email
              </label>
              <input
                id="email"
                ref={emailInputRef}
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (fieldErrors.email) {
                    setFieldErrors((current) => ({ ...current, email: undefined }));
                  }
                }}
                aria-describedby={fieldErrors.email ? "sign-up-email-error" : undefined}
                aria-invalid={fieldErrors.email ? "true" : "false"}
                autoComplete="email"
                className={`mt-1.5 block w-full rounded-xl border bg-[var(--color-surface)] px-4 py-3 text-base text-[var(--color-text-primary)] placeholder-[var(--color-text-secondary)] transition-all duration-150 ease focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)] ${
                  fieldErrors.email
                    ? "border-[var(--color-danger)]"
                    : "border-[var(--color-border)]"
                }`}
                placeholder="you@example.com"
              />
              {fieldErrors.email && (
                <p
                  id="sign-up-email-error"
                  className="mt-1 text-xs"
                  role="alert"
                  style={{ color: 'var(--color-danger)' }}
                >
                  {fieldErrors.email}
                </p>
              )}
            </div>

            {/* Password */}
            <div>
              <label
                htmlFor="password"
                className="block text-base font-medium text-[var(--color-text-primary)]"
              >
                Password
              </label>
              <div className="relative mt-1.5">
                <input
                  id="password"
                  ref={passwordInputRef}
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (fieldErrors.password) {
                      setFieldErrors((current) => ({ ...current, password: undefined }));
                    }
                  }}
                  aria-describedby={fieldErrors.password ? "sign-up-password-error" : undefined}
                  aria-invalid={fieldErrors.password ? "true" : "false"}
                  autoComplete="new-password"
                  className={`block w-full rounded-xl border bg-[var(--color-surface)] px-4 py-3 pr-10 text-base text-[var(--color-text-primary)] placeholder-[var(--color-text-secondary)] transition-all duration-150 ease focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)] ${
                    fieldErrors.password
                      ? "border-[var(--color-danger)]"
                      : "border-[var(--color-border)]"
                  }`}
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-0 top-1/2 flex min-h-11 min-w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition-colors duration-150 hover:text-[var(--color-text-primary)]"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                      <path fillRule="evenodd" d="M3.28 2.22a.75.75 0 00-1.06 1.06l14.5 14.5a.75.75 0 101.06-1.06l-1.745-1.745a10.029 10.029 0 003.3-4.38 1.651 1.651 0 000-1.185A10.004 10.004 0 009.999 3a9.956 9.956 0 00-4.744 1.194L3.28 2.22zM7.752 6.69l1.092 1.092a2.5 2.5 0 013.374 3.373l1.092 1.092a4 4 0 00-5.558-5.558z" clipRule="evenodd" />
                      <path d="M10.748 13.93l2.523 2.523A9.987 9.987 0 0110 17c-4.257 0-7.855-2.66-9.336-6.41a1.651 1.651 0 010-1.186A10.007 10.007 0 014.09 5.12l2.109 2.109a4 4 0 004.55 4.55z" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                      <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
                      <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </button>
              </div>
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">8+ characters</p>
              {fieldErrors.password && (
                <p
                  id="sign-up-password-error"
                  className="mt-1 text-xs"
                  role="alert"
                  style={{ color: 'var(--color-danger)' }}
                >
                  {fieldErrors.password}
                </p>
              )}
            </div>

            {/* Submit */}
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={isBusy}>
              Create account
            </Button>
          </form>

          <div className="relative mt-4 rounded-2xl border border-[var(--color-border)]/80 bg-[var(--color-surface)]/75 p-3">
            <Link
              href={guestChatHref}
              className="flex min-h-11 items-center justify-center rounded-xl border border-[color-mix(in_srgb,var(--color-primary),transparent_68%)] bg-[color-mix(in_srgb,var(--color-primary-soft),white_16%)] px-4 py-3 text-sm font-semibold text-[var(--color-primary)] transition-colors hover:border-[var(--color-primary)]/50 hover:bg-[var(--color-primary-soft)]"
            >
              Continue as guest
            </Link>
            <p className="mt-2 text-center text-xs leading-5 text-[var(--color-text-secondary)]">
              Try Eco first. You can create an account anytime.
            </p>
          </div>

          {/* Divider */}
          {anyOAuthEnabled && (
            <div className="relative my-8">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-[var(--color-border)]" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-[var(--color-surface-raised)] px-3 text-[var(--color-text-secondary)]">
                  or
                </span>
              </div>
            </div>
          )}

          {/* OAuth buttons */}
          <div className="relative space-y-2.5">
            {googleEnabled && (
              <Button type="button" variant="secondary" size="lg" className="w-full rounded-full" onClick={() => handleOAuth("google")}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                </svg>
                Continue with Google
              </Button>
            )}
            {githubEnabled && (
              <Button type="button" variant="secondary" size="lg" className="w-full rounded-full" onClick={() => handleOAuth("github")}>
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                </svg>
                Continue with GitHub
              </Button>
            )}
          </div>
        </div>

        {/* Footer link */}
        <p className="mt-6 text-center text-sm text-[var(--color-text-secondary)]">
          Already have an account?{" "}
          <Link
            href={signInHref}
            className="font-medium text-[var(--color-primary)] hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function SignUpPage() {
  return (
    <Suspense>
      <SignUpForm />
    </Suspense>
  );
}
