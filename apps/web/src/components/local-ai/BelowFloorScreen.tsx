// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useState } from 'react';
import { Button } from '@eco/ui';
import { SeedlingIllustration } from '@eco/ui';

/**
 * Below-floor screen — for devices that genuinely can't run Eco today
 * (vision §1.2c). The user never sees a chat surface they can't use.
 *
 * Provides:
 *   - A calm explanation that Eco is coming to their device, TRUE to the
 *     actual reason it can't run here (runtime / memory / fallback)
 *   - Email signup (caller-provided action)
 *   - "What works today" disclosure
 */

/**
 * Why Eco can't run on this device:
 *   - `runtime`  : neither WebGPU nor a viable WASM tier — the browser can't
 *                  do on-device inference yet.
 *   - `memory`   : the browser is fine, but there isn't enough memory to run
 *                  a model well.
 *   - `fallback` : capable-but-unclassified — no model was assignable for some
 *                  other reason.
 */
export type BelowFloorReasonKind = 'runtime' | 'memory' | 'fallback';

export type BelowFloorScreenProps = {
  /** The user-friendly device/browser tag — e.g. "Safari on iPhone". */
  deviceLabel?: string;
  /**
   * Why the device is below floor. Governs the explanation copy so we tell the
   * truth per population instead of blaming the browser for everyone. Defaults
   * to 'runtime' (the historical single message) so unwired call sites stay
   * valid.
   */
  reason?: BelowFloorReasonKind;
  /** Called when the user opts in to be notified. */
  onSignup(email: string): Promise<void>;
};

export function BelowFloorScreen({ deviceLabel, reason = 'runtime', onSignup }: BelowFloorScreenProps) {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disclosureOpen, setDisclosureOpen] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!email || !email.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSignup(email);
      setConfirmed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main
      className="min-h-screen w-full flex flex-col items-center justify-center px-6 pt-12"
      style={{
        // The dismissable cookie notice is a fixed bottom element; on /chat it
        // anchors bottom-right and used to sit over the "What works today"
        // disclosure. Reserve its band (plus the safe-area inset) below the
        // centered content so the two never collide.
        paddingBottom:
          'calc(var(--eco-space-3xl) + var(--eco-space-2xl) + env(safe-area-inset-bottom))',
        background: 'var(--eco-surface)',
        color: 'var(--eco-text)',
        fontFamily: 'var(--eco-font-body)',
      }}
    >
      <div className="flex flex-col items-center text-center max-w-md w-full gap-6">
        <div role="img" aria-label="A young seedling — Eco is coming to your device.">
          <SeedlingIllustration size={180} />
        </div>

        <h1 className="font-display text-3xl tracking-tight">Eco</h1>

        <p className="text-base leading-relaxed" style={{ color: 'var(--eco-text)' }}>
          {reason === 'memory' ? (
            <>
              Eco&apos;s AI runs entirely on your device — and this device doesn&apos;t have enough memory for it to run well. On a computer with more memory, Eco just works.
            </>
          ) : reason === 'fallback' ? (
            <>
              Eco&apos;s AI runs entirely on your device — and it isn&apos;t ready for this setup yet. We&apos;re working to change that.
            </>
          ) : (
            <>
              {/* Explicit {' '} + a self-contained label branch keep the space between
                  "browser" and the next word on BOTH paths. Relying on JSX text-adjacent-
                  to-expression whitespace fused the words to "browsercan't" on the no-label
                  path under SWC/Turbopack (Dim B PR-B3). */}
              Eco&apos;s AI runs entirely on your device — and this browser{' '}
              {deviceLabel ? `(${deviceLabel}) ` : ''}can&apos;t do that yet. We&apos;re working with browser vendors to change it.
            </>
          )}
        </p>

        {confirmed ? (
          <p className="text-sm" style={{ color: 'var(--eco-success)' }}>
            Thanks — we&apos;ll let you know when Eco arrives on your device.
          </p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3 w-full max-w-xs">
            <p className="text-sm" style={{ color: 'var(--eco-text-secondary)' }}>
              {reason === 'memory'
                ? "We'll email you when lighter models arrive."
                : "We'll email you when Eco arrives."}
            </p>
            <input
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-xl px-4 py-3 text-sm"
              style={{
                background: 'var(--eco-surface-elevated)',
                border: '1px solid var(--eco-border)',
                color: 'var(--eco-text)',
                fontFamily: 'var(--eco-font-body)',
              }}
              aria-label="Email address"
            />
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Saving...' : 'Sign me up'}
            </Button>
            {error && (
              <p className="text-xs" style={{ color: 'var(--eco-error)' }}>
                {error}
              </p>
            )}
          </form>
        )}

        <div className="mt-4 w-full">
          <button
            type="button"
            onClick={() => setDisclosureOpen((s) => !s)}
            className="text-sm underline"
            style={{ color: 'var(--eco-text-secondary)' }}
            aria-expanded={disclosureOpen}
          >
            {disclosureOpen ? 'Hide what works today' : 'What works today ›'}
          </button>
          {disclosureOpen && (
            <div
              className="mt-4 text-left text-sm rounded-2xl px-5 py-4"
              style={{
                background: 'var(--eco-surface-elevated)',
                border: '1px solid var(--eco-border-muted)',
                color: 'var(--eco-text)',
              }}
            >
              <p className="mb-3">Eco runs today on:</p>
              <ul className="list-disc pl-5 space-y-1" style={{ color: 'var(--eco-text-secondary)' }}>
                <li>Chrome / Edge on a desktop with WebGPU (most laptops from 2022 or newer)</li>
                <li>Safari on a Mac (limited models, WebAssembly mode)</li>
                <li>Firefox on a desktop (limited models, WebAssembly mode)</li>
              </ul>
              <p className="mt-3" style={{ color: 'var(--eco-text-secondary)' }}>
                We&apos;re working with browser teams to expand this list.
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
