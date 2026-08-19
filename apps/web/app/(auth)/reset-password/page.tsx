// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { EcoLogo } from "../../../src/components/EcoLogo";
import { Button } from "@eco/ui";
import Link from "next/link";
import {
  buildAuthPageHref,
  buildChatContinuationHref,
  buildRecoveryPageHref,
  resolveAuthSuccessNavigation,
} from "../../../src/lib/auth-continuation";

const INVALID_LINK_HEADING = "This reset link isn't valid";
// Two honest variants, same calm register and same forward-pointing close.
const EXPIRED_LINK_COPY =
  "Reset links only last an hour. Request a fresh one and we'll get you right back in.";
const INCOMPLETE_LINK_COPY =
  "This link is incomplete. Request a fresh one and we'll get you right back in.";

// One Fraunces card title, shared across states so the type treatment never drifts.
function CardHeading({ children }: { children: React.ReactNode }) {
  return (
    <h1
      className="text-center font-serif text-[var(--eco-text)]"
      style={{ fontSize: "clamp(1.25rem, 1rem + 1.25vw, 1.5rem)" }}
    >
      {children}
    </h1>
  );
}

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  // Better Auth redirects expired/invalid reset links here with ?error=INVALID_TOKEN
  // (and no token) — tell the user the link died rather than blaming their email.
  const linkError = searchParams.get("error");
  const callbackUrl = searchParams.get("callbackUrl");
  const prompt = searchParams.get("prompt");
  const { promptToResume } = resolveAuthSuccessNavigation(callbackUrl, prompt);
  const signInHref = buildAuthPageHref("/sign-in", { callbackUrl, prompt });
  const forgotPasswordHref = buildRecoveryPageHref("/forgot-password", {
    callbackUrl,
    prompt,
  });
  const localChatHref = buildChatContinuationHref(promptToResume);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const confirmPasswordInputRef = useRef<HTMLInputElement>(null);
  const missingToken = !token;

  // A tokenless link can never succeed, so we never render the password form for
  // it — a dedicated state points the user at a fresh link instead of a dead end.
  if (missingToken) {
    return (
      <>
        <CardHeading>{INVALID_LINK_HEADING}</CardHeading>
        <div className="mt-6 text-center">
          <p className="text-sm text-[var(--eco-text-secondary)]" role="alert">
            {linkError ? EXPIRED_LINK_COPY : INCOMPLETE_LINK_COPY}
          </p>
          <div className="mt-6 flex flex-col items-center gap-3">
            <Link href={forgotPasswordHref} className="inline-block">
              <Button variant="primary" size="lg">
                Request a new link
              </Button>
            </Link>
            <Link
              href={signInHref}
              className="text-sm font-medium text-[var(--eco-primary)] hover:underline"
            >
              Back to sign in
            </Link>
          </div>
        </div>
      </>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!password) {
      setError("Password is required");
      passwordInputRef.current?.focus();
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      passwordInputRef.current?.focus();
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      confirmPasswordInputRef.current?.focus();
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: password, token }),
      });
      if (!res.ok) throw new Error("Failed to reset password");
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset password");
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <>
        <CardHeading>Set new password</CardHeading>
        <div className="mt-6 text-center" role="status" aria-live="polite">
          <p className="text-sm text-[var(--eco-text-secondary)]">
            Your password has been reset successfully.
          </p>
          <div className="mt-6 flex flex-col items-center gap-3">
            <Link href={signInHref} className="inline-block">
              <Button variant="primary" size="lg">
                Sign in
              </Button>
            </Link>
            <Link href={localChatHref} className="text-sm font-medium text-[var(--eco-primary)] hover:underline">
              Continue to local chat
            </Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <CardHeading>Set new password</CardHeading>
      {error && (
        <div id="reset-password-error" role="alert" className="mt-4 rounded-xl px-4 py-2.5 text-sm" style={{ backgroundColor: 'var(--eco-coral-soft)', color: 'var(--eco-coral)' }}>
          {error}
        </div>
      )}

      <form noValidate onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="password" className="block text-base font-medium text-[var(--eco-text)]">New password</label>
          <div className="relative mt-1.5">
            <input
              id="password"
              ref={passwordInputRef}
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              aria-describedby={error ? "reset-password-error" : undefined}
              aria-invalid={error ? "true" : "false"}
              autoComplete="new-password"
              className={`block w-full rounded-xl border bg-[var(--eco-surface)] px-4 py-3 pr-10 text-base text-[var(--eco-text)] placeholder-[var(--eco-text-secondary)] transition-all duration-150 ease focus:outline-none ${
                error
                  ? "border-[var(--eco-coral)] focus:border-[var(--eco-coral)] focus:ring-2 focus:ring-[var(--eco-coral)]/20"
                  : "border-[var(--eco-border)] focus:border-[var(--eco-primary)] focus:ring-2 focus:ring-[var(--eco-primary)]/20"
              }`}
              placeholder="At least 8 characters"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-[var(--eco-text-secondary)] transition-colors duration-150 hover:text-[var(--eco-text)]"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                {showPassword ? (
                  <path fillRule="evenodd" d="M3.28 2.22a.75.75 0 00-1.06 1.06l14.5 14.5a.75.75 0 101.06-1.06l-1.745-1.745a10.029 10.029 0 003.3-4.38 1.651 1.651 0 000-1.185A10.004 10.004 0 009.999 3a9.956 9.956 0 00-4.744 1.194L3.28 2.22zM7.752 6.69l1.092 1.092a2.5 2.5 0 013.374 3.373l1.092 1.092a4 4 0 00-5.558-5.558z" clipRule="evenodd" />
                ) : (
                  <>
                    <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
                    <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
                  </>
                )}
              </svg>
            </button>
          </div>
        </div>

        <div>
          <label htmlFor="confirm-password" className="block text-base font-medium text-[var(--eco-text)]">Confirm password</label>
          <input
            id="confirm-password"
            ref={confirmPasswordInputRef}
            type={showPassword ? "text" : "password"}
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              setError(null);
            }}
            aria-describedby={error ? "reset-password-error" : undefined}
            aria-invalid={error ? "true" : "false"}
            autoComplete="new-password"
            className={`mt-1.5 block w-full rounded-xl border bg-[var(--eco-surface)] px-4 py-3 text-base text-[var(--eco-text)] placeholder-[var(--eco-text-secondary)] transition-all duration-150 ease focus:outline-none ${
              error
                ? "border-[var(--eco-coral)] focus:border-[var(--eco-coral)] focus:ring-2 focus:ring-[var(--eco-coral)]/20"
                : "border-[var(--eco-border)] focus:border-[var(--eco-primary)] focus:ring-2 focus:ring-[var(--eco-primary)]/20"
            }`}
            placeholder="Repeat your password"
          />
        </div>

        <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
          Reset password
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-[var(--eco-text-secondary)]">
        <Link href={signInHref} className="font-medium transition-colors hover:underline" style={{ color: 'var(--eco-primary)' }}>
          Back to sign in
        </Link>
        <span aria-hidden="true"> · </span>
        <Link href={forgotPasswordHref} className="font-medium transition-colors hover:underline" style={{ color: 'var(--eco-primary)' }}>
          Request a new link
        </Link>
      </p>
      <p className="mt-4 flex justify-center gap-3 text-xs">
        <Link href={localChatHref} className="text-[var(--eco-text-secondary)] hover:underline">
          Local chat
        </Link>
        <Link href="/privacy" className="text-[var(--eco-text-secondary)] hover:underline">
          Privacy
        </Link>
        <Link href="/transparency" className="text-[var(--eco-text-secondary)] hover:underline">
          Transparency
        </Link>
      </p>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="grain relative flex min-h-dvh items-center justify-center overflow-hidden bg-[var(--eco-surface)] px-4">
      {/* Mountain silhouettes — connects to landing valley */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-80 sm:h-96" aria-hidden="true">
        <svg viewBox="0 0 1440 320" fill="none" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          <path d="M0 320 L0 220 Q120 160 280 200 Q440 140 600 180 Q760 120 920 170 Q1080 110 1240 160 Q1360 130 1440 180 L1440 320Z" fill="var(--color-accent)" opacity="0.08" />
          <path d="M0 320 L0 240 Q180 180 360 210 Q540 160 720 200 Q900 150 1080 190 Q1260 160 1440 210 L1440 320Z" fill="var(--color-accent)" opacity="0.14" />
          <path d="M0 320 L0 270 Q240 230 480 255 Q720 220 960 245 Q1200 225 1440 260 L1440 320Z" fill="var(--color-primary)" opacity="0.20" />
        </svg>
        {/* Scattered leaf accents */}
        <svg className="absolute bottom-16 left-[12%] h-8 w-8 opacity-[0.13] rotate-[-30deg]" viewBox="0 0 32 32" fill="none">
          <path d="M7 25C7 25 5.5 16 11 11C16.5 6 25 4.5 28 4.5C28 4.5 29.5 13.5 24 19C18.5 24.5 10 25 7 25Z" fill="var(--color-primary)" />
        </svg>
        <svg className="absolute bottom-24 right-[15%] h-6 w-6 opacity-[0.11] rotate-[45deg]" viewBox="0 0 32 32" fill="none">
          <path d="M7 25C7 25 5.5 16 11 11C16.5 6 25 4.5 28 4.5C28 4.5 29.5 13.5 24 19C18.5 24.5 10 25 7 25Z" fill="var(--color-primary)" />
        </svg>
        <svg className="absolute bottom-32 left-[45%] h-5 w-5 opacity-[0.10] rotate-[15deg]" viewBox="0 0 32 32" fill="none">
          <path d="M7 25C7 25 5.5 16 11 11C16.5 6 25 4.5 28 4.5C28 4.5 29.5 13.5 24 19C18.5 24.5 10 25 7 25Z" fill="var(--color-primary)" />
        </svg>
        <svg className="absolute bottom-40 right-[35%] h-5 w-5 opacity-[0.10] rotate-[-50deg]" viewBox="0 0 32 32" fill="none">
          <path d="M7 25C7 25 5.5 16 11 11C16.5 6 25 4.5 28 4.5C28 4.5 29.5 13.5 24 19C18.5 24.5 10 25 7 25Z" fill="var(--color-accent)" />
        </svg>
      </div>

      {/* Warm glow behind card */}
      <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full opacity-[0.12]" style={{ background: 'radial-gradient(circle, var(--color-accent) 0%, transparent 70%)' }} aria-hidden="true" />

      <div className="relative z-10 w-full max-w-md">
        <div className="mb-10 flex justify-center">
          <Link href="/" aria-label="Go to homepage">
            <EcoLogo size="lg" />
          </Link>
        </div>

        <div className="rounded-2xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-6 sm:p-10 shadow-sm">
          <Suspense fallback={<div className="text-center text-sm text-[var(--eco-text-secondary)]">Loading...</div>}>
            <ResetPasswordForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
