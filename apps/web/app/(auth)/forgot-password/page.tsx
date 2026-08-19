// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { Suspense, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { EcoLogo } from "../../../src/components/EcoLogo";
import { Button } from "@eco/ui";
import Link from "next/link";
import {
  buildAuthPageHref,
  buildChatContinuationHref,
  buildRecoveryPageHref,
  resolveAuthSuccessNavigation,
  toAbsoluteWebUrl,
} from "../../../src/lib/auth-continuation";

function ForgotPasswordForm() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl");
  const prompt = searchParams.get("prompt");
  const { promptToResume } = resolveAuthSuccessNavigation(callbackUrl, prompt);
  const signInHref = buildAuthPageHref("/sign-in", { callbackUrl, prompt });
  const localChatHref = buildChatContinuationHref(promptToResume);
  const resetRedirectTo = buildRecoveryPageHref("/reset-password", {
    callbackUrl,
    prompt,
  });
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedEmail = email.trim();

    if (!trimmedEmail) {
      setError("Email is required");
      emailInputRef.current?.focus();
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError("Enter a valid email address");
      emailInputRef.current?.focus();
      return;
    }

    setLoading(true);
    try {
      // better-auth 1.4 renamed the endpoint: /forget-password no longer
      // exists (404) — it's /request-password-reset with the same body.
      const res = await fetch(`/api/auth/request-password-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // redirectTo must be absolute: the emailed link's redirect resolves
        // relative URLs against the API origin, which has no /reset-password.
        body: JSON.stringify({
          email: trimmedEmail,
          redirectTo: toAbsoluteWebUrl(resetRedirectTo),
        }),
      });
      if (!res.ok) throw new Error("Failed to send reset email");
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send reset email");
    } finally {
      setLoading(false);
    }
  }

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
          <h1 className="text-center font-serif text-[var(--eco-text)]" style={{ fontSize: 'clamp(1.25rem, 1rem + 1.25vw, 1.5rem)' }}>
            Reset your password
          </h1>

          {sent ? (
            <div className="mt-6 text-center" role="status" aria-live="polite">
              <p className="text-sm text-[var(--eco-text-secondary)]">
                Check your email for a reset link. If you don&apos;t see it, check your spam folder.
              </p>
              <div className="mt-6 flex flex-col items-center gap-3">
                <Link
                  href={signInHref}
                  className="text-sm font-medium transition-colors hover:underline"
                  style={{ color: 'var(--eco-primary)' }}
                >
                  Back to sign in
                </Link>
                <Link
                  href={localChatHref}
                  className="text-sm font-medium transition-colors hover:underline"
                  style={{ color: 'var(--eco-primary)' }}
                >
                  Continue to local chat
                </Link>
              </div>
            </div>
          ) : (
            <>
              {error && (
                <div id="forgot-password-error" role="alert" className="mt-4 rounded-xl px-4 py-2.5 text-sm" style={{ backgroundColor: 'var(--eco-coral-soft)', color: 'var(--eco-coral)' }}>
                  {error}
                </div>
              )}

              <p className="mt-4 text-center text-sm text-[var(--eco-text-secondary)]">
                Enter your email and we&apos;ll send you a link to reset your password.
              </p>

              <form noValidate onSubmit={handleSubmit} className="mt-6 space-y-4">
                <div>
                  <label htmlFor="email" className="block text-base font-medium text-[var(--eco-text)]">Email</label>
                  <input
                    id="email"
                    ref={emailInputRef}
                    type="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setError(null);
                    }}
                    aria-describedby={error ? "forgot-password-error" : undefined}
                    aria-invalid={error ? "true" : "false"}
                    autoComplete="email"
                    className={`mt-1.5 block w-full rounded-xl border bg-[var(--eco-surface)] px-4 py-3 text-base text-[var(--eco-text)] placeholder-[var(--eco-text-secondary)] transition-all duration-150 ease focus:outline-none ${
                      error
                        ? "border-[var(--eco-coral)] focus:border-[var(--eco-coral)] focus:ring-2 focus:ring-[var(--eco-coral)]/20"
                        : "border-[var(--eco-border)] focus:border-[var(--eco-primary)] focus:ring-2 focus:ring-[var(--eco-primary)]/20"
                    }`}
                    placeholder="you@example.com"
                  />
                </div>

                <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
                  Send reset link
                </Button>
              </form>

              <p className="mt-6 text-center text-sm text-[var(--eco-text-secondary)]">
                <Link href={signInHref} className="font-medium transition-colors hover:underline" style={{ color: 'var(--eco-primary)' }}>
                  Back to sign in
                </Link>
                <span aria-hidden="true"> · </span>
                <Link href={localChatHref} className="font-medium transition-colors hover:underline" style={{ color: 'var(--eco-primary)' }}>
                  Continue to local chat
                </Link>
              </p>
              <p className="mt-4 flex justify-center gap-3 text-xs">
                <Link href="/privacy" className="text-[var(--eco-text-secondary)] hover:underline">
                  Privacy
                </Link>
                <Link href="/terms" className="text-[var(--eco-text-secondary)] hover:underline">
                  Terms
                </Link>
                <Link href="/transparency" className="text-[var(--eco-text-secondary)] hover:underline">
                  Transparency
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="grain relative flex min-h-dvh items-center justify-center overflow-hidden bg-[var(--eco-surface)] px-4">
          <div className="text-sm text-[var(--eco-text-secondary)]">Loading…</div>
        </div>
      }
    >
      <ForgotPasswordForm />
    </Suspense>
  );
}
