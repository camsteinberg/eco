// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { EcoLogo } from "../../src/components/EcoLogo";
import { sanitizeRelativeUrl } from "../../src/lib/auth-continuation";

function GateForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [gateConfigured, setGateConfigured] = useState<boolean | null>(true);
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = sanitizeRelativeUrl(searchParams.get("returnTo"), "/chat");

  useEffect(() => {
    let active = true;

    async function checkGateStatus() {
      try {
        const res = await fetch("/api/gate", { method: "GET" });
        if (!res.ok) return;
        const data = (await res.json()) as { configured?: boolean };
        if (active) {
          setGateConfigured(Boolean(data.configured));
        }
      } catch {
        // Keep the password form available if the status probe is unavailable.
      }
    }

    void checkGateStatus();

    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    let shouldRestoreControls = true;

    try {
      const res = await fetch("/api/gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        shouldRestoreControls = false;
        router.push(returnTo);
      } else {
        setError("That password isn\u2019t right. Try again.");
      }
    } catch {
      setError("We couldn\u2019t reach the access gate. Check your connection and try again.");
    } finally {
      if (shouldRestoreControls) {
        setLoading(false);
      }
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-sans), system-ui, sans-serif",
        background: "var(--eco-surface)",
        color: "var(--eco-text)",
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          width: "100%",
          maxWidth: "360px",
          padding: "2rem",
        }}
      >
        <div style={{ display: "flex", justifyContent: "center" }}>
          <EcoLogo size="lg" />
        </div>
        <h1
          style={{
            fontFamily: "var(--eco-font-display)",
            fontSize: "1.5rem",
            fontWeight: 600,
            textAlign: "center",
            margin: 0,
          }}
        >
          Early access
        </h1>
        <p
          style={{
            fontSize: "0.875rem",
            textAlign: "center",
            opacity: 0.6,
            margin: 0,
          }}
        >
          Eco&apos;s local-first chat launch is in private preview.
        </p>
        {gateConfigured === false ? (
          <div role="status" aria-live="polite" style={{ display: "grid", gap: "1rem" }}>
            <p
              style={{
                border: "1px solid var(--eco-border)",
                borderRadius: "16px",
                background: "var(--eco-primary-soft)",
                color: "var(--eco-text)",
                fontSize: "0.875rem",
                lineHeight: 1.6,
                margin: 0,
                padding: "1rem",
                textAlign: "center",
              }}
            >
              The private launch gate is open right now. You can start a local chat without entering a password.
            </p>
            <Link
              href={returnTo}
              style={{
                padding: "0.75rem 1rem",
                borderRadius: "999px",
                background: "var(--eco-primary)",
                color: "white",
                fontSize: "1rem",
                fontWeight: 600,
                textAlign: "center",
                textDecoration: "none",
              }}
            >
              Start Chat
            </Link>
          </div>
        ) : (
          <>
            <label htmlFor="gate-password" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
              Access password
            </label>
            <input
              id="gate-password"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError("");
              }}
              aria-describedby={error ? "gate-password-error" : "gate-password-help"}
              aria-invalid={error ? "true" : "false"}
              placeholder="Password"
              autoFocus
              required
              className={`block w-full rounded-xl border bg-[var(--eco-surface-elevated)] px-4 py-3 text-base text-[var(--eco-text)] placeholder-[var(--eco-text-secondary)] transition-all duration-150 ease focus:outline-none ${
                error
                  ? "border-[var(--eco-coral)] focus:border-[var(--eco-coral)] focus:ring-2 focus:ring-[var(--eco-coral)]/20"
                  : "border-[var(--eco-border)] focus:border-[var(--eco-primary)] focus:ring-2 focus:ring-[var(--eco-primary)]/20"
              }`}
            />
            <p id="gate-password-help" style={{ fontSize: "0.75rem", margin: "-0.5rem 0 0", color: "var(--eco-text-secondary)" }}>
              The gate protects this preview; local AI remains available after access.
            </p>
            {error && (
              <p
                id="gate-password-error"
                role="alert"
                style={{ color: "var(--eco-coral)", fontSize: "0.875rem", margin: 0, textAlign: "center" }}
              >
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={loading}
              aria-busy={loading ? "true" : "false"}
              style={{
                padding: "0.75rem 1rem",
                borderRadius: "999px",
                border: "none",
                background: "var(--eco-primary)",
                color: "white",
                fontSize: "1rem",
                fontWeight: 600,
                cursor: loading ? "wait" : "pointer",
                opacity: loading ? 0.7 : 1,
              }}
            >
              {loading ? "Checking access..." : "Enter"}
            </button>
          </>
        )}
        <p style={{ display: "flex", justifyContent: "center", gap: "0.75rem", fontSize: "0.75rem", margin: "0.5rem 0 0" }}>
          <Link href="/privacy" style={{ color: "var(--eco-text-secondary)" }}>Privacy</Link>
          <Link href="/terms" style={{ color: "var(--eco-text-secondary)" }}>Terms</Link>
          <Link href="/transparency" style={{ color: "var(--eco-text-secondary)" }}>Transparency</Link>
          <Link href="/impact" style={{ color: "var(--eco-text-secondary)" }}>Impact</Link>
        </p>
      </form>
    </main>
  );
}

export default function GatePage() {
  return (
    <Suspense
      fallback={
        <main
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--font-sans), system-ui, sans-serif",
            background: "var(--eco-surface)",
            color: "var(--eco-text-secondary)",
          }}
        >
          Loading gate…
        </main>
      }
    >
      <GateForm />
    </Suspense>
  );
}
