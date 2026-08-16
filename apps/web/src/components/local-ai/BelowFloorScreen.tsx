// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Button } from '@eco/ui';
import { SeedlingIllustration } from '@eco/ui';

/**
 * Below-floor screen — for devices that genuinely can't run Eco today
 * (vision §1.2c). The user never sees a chat surface they can't use.
 *
 * Provides:
 *   - A calm explanation that Eco is coming to their device, TRUE to the
 *     actual reason it can't run here (runtime / memory / fallback)
 *   - An honest "Email us" handoff: a real mailto to a real inbox the user
 *     opens themselves, so nothing is captured or stored here. (MC-1 replaced
 *     an email field + "Sign me up" + "we'll let you know" that implied a
 *     waitlist backend we don't run — there is no automated signup.)
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
 *   - `mobile`   : iOS WebKit (phone/tablet). Gated BEFORE any load because the
 *                  model load itself crash-loops the tab (working-set vs iOS
 *                  memory ceiling). A designed handoff surface, not a dead end.
 */
export type BelowFloorReasonKind = 'runtime' | 'memory' | 'fallback' | 'mobile';

/** Where we send people to run Eco. Kept in one place for the handoff + copy. */
const ECO_URL = 'https://econetwork.ai';

/** The real inbox behind the "Email us" handoff. A person reads it — there is
 *  no automated waitlist, so the copy promises a reply, not a subscription. */
const CONTACT_EMAIL = 'hello@econetwork.ai';

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
};

/** The one line beside the Email-us action — true to why this device can't run
 *  Eco yet, and framed as a reply we send, not a list we add them to. */
function notifyCopy(reason: BelowFloorReasonKind): string {
  switch (reason) {
    case 'mobile':
      return "Email us and we'll tell you when this device is supported.";
    case 'memory':
      return "Email us and we'll tell you when lighter models arrive.";
    case 'fallback':
      return "Email us and we'll tell you when Eco is ready for this setup.";
    default:
      return "Email us and we'll tell you when your browser is supported.";
  }
}

/** A pre-addressed mailto: the user's own mail client supplies their address
 *  (nothing is captured on this screen), and we get the device context we'd
 *  need to follow up. */
function emailUsHref(reason: BelowFloorReasonKind, deviceLabel?: string): string {
  const subject = 'Eco — let me know when my device is supported';
  const body = [
    "I'd like to know when Eco can run on my device.",
    '',
    `Device: ${deviceLabel ?? 'unknown'}`,
    `Reason: ${reason}`,
  ].join('\n');
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function BelowFloorScreen({ deviceLabel, reason = 'runtime' }: BelowFloorScreenProps) {
  const [disclosureOpen, setDisclosureOpen] = useState(false);

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
        <div
          role="img"
          aria-label={
            reason === 'mobile'
              ? 'A young seedling — Eco runs on iPhone and iPad, just not this one yet.'
              : 'A young seedling — Eco is coming to your device.'
          }
        >
          <SeedlingIllustration size={180} />
        </div>

        <h1 className="font-display text-3xl tracking-tight">Eco</h1>

        <p className="text-base leading-relaxed" style={{ color: 'var(--eco-text)' }}>
          {reason === 'mobile' ? (
            <>
              Eco&apos;s AI runs entirely on your device — nothing goes to a server. Eco does run on iPhone and iPad; it just can&apos;t run on this one yet, and updating to the latest iOS is the most likely fix. In the meantime, it works on your computer today.
            </>
          ) : reason === 'memory' ? (
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

        {reason === 'mobile' && <MobileHandoff />}

        <div className="flex flex-col items-center gap-3 w-full max-w-xs">
          <p className="text-sm" style={{ color: 'var(--eco-text-secondary)' }}>
            {notifyCopy(reason)}
          </p>
          {/* A real mailto link, not a form: it opens the user's own mail client
              (which supplies their address), so nothing on this screen collects or
              stores anything. It's an <a>, not the @eco/ui <Button> (button-only),
              because a mailto is a link — the native affordance works without JS
              and long-press reveals the address. Styled to the primary/secondary
              button so it reads as the CTA. On mobile the native handoff is the one
              primary CTA, so Email us drops to the quiet outline (secondary) to
              avoid two competing green buttons. */}
          <a
            href={emailUsHref(reason, deviceLabel)}
            className={[
              'w-full inline-flex items-center justify-center gap-2 font-medium transition-colors',
              'px-5 py-2.5 text-sm rounded-[var(--eco-radius-sm)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]/30 focus-visible:ring-offset-2',
              reason === 'mobile'
                ? 'border border-[var(--eco-primary)] text-[var(--eco-primary)] hover:bg-[var(--eco-primary-soft)]'
                : 'bg-[var(--eco-primary)] text-[var(--eco-on-primary)] hover:bg-[var(--eco-primary-hover)]',
            ].join(' ')}
          >
            Email us
          </a>
        </div>

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

/**
 * Native handoff — the signature of the mobile surface. The premise: the user
 * is on a phone, but Eco runs great on their computer, so the fastest path is
 * to send the link to it. On iOS `navigator.share` opens the system share sheet
 * (AirDrop / Messages / Mail / Notes) — the native, premiere-feeling mechanism.
 *
 * When Web Share is unavailable (desktop browsers, some engines) we fall back to
 * copy-to-clipboard with a confirmed "Link copied" state. A share the user
 * cancels rejects with AbortError — that is not an error, so we swallow it.
 */
function MobileHandoff() {
  const reduceMotion = useReducedMotion();
  // Lazy, client-only: this surface renders only after async setup resolves in
  // the browser, so there is no SSR pass to mismatch against.
  const [canShare] = useState(
    () => typeof navigator !== 'undefined' && typeof navigator.share === 'function',
  );
  const [copied, setCopied] = useState(false);

  const share = async (): Promise<void> => {
    try {
      await navigator.share({ title: 'Eco', url: ECO_URL });
    } catch {
      // User dismissed the share sheet (AbortError) or the engine refused —
      // either way there is nothing to report. Stay silent.
    }
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(ECO_URL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2400);
    } catch {
      // Clipboard blocked (permissions / insecure context). Leave the label as
      // "Copy link" — the visible URL below is still there to type by hand.
    }
  };

  return (
    <div className="flex flex-col items-center gap-2 w-full max-w-xs">
      {canShare ? (
        <Button
          type="button"
          variant="primary"
          className="w-full"
          onClick={() => {
            void share();
          }}
        >
          Send Eco to your computer
        </Button>
      ) : (
        <Button
          type="button"
          variant="primary"
          className="w-full"
          onClick={() => {
            void copy();
          }}
          aria-live="polite"
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={copied ? 'copied' : 'copy'}
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -4 }}
              transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 32 }}
            >
              {copied ? 'Link copied' : 'Copy link'}
            </motion.span>
          </AnimatePresence>
        </Button>
      )}
      <p className="text-xs" style={{ color: 'var(--eco-text-secondary)' }}>
        econetwork.ai
      </p>
    </div>
  );
}
