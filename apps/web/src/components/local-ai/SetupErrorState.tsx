// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useState } from 'react';
import { Button } from '@eco/ui';
import { WiltedPlant } from '@eco/ui';
import { exportDiagnostics } from '../../local-ai/diagnostics/capture';
import type { AttemptFailureReasonCode } from '../../local-ai/lifecycle/setup-cascade';

/**
 * Setup error state — shown after the download pipeline exhausts its
 * automatic retries (vision §1.2a / §1.2b).
 *
 * Tone: calm, factual, actionable. No technical IDs. No apology. No shame.
 */

export type SetupErrorStateProps = {
  reason: string;
  /**
   * The structured cause, when the setup ladder knew one. This takes precedence
   * over anything read out of `reason`, and it is what makes the connectivity
   * copy reachable at all: once the ladder is exhausted the cascade replaces the
   * real failure text with its own line, so there is nothing left in `reason`
   * to sniff. Omitted = the cause is genuinely unknown; say nothing about it.
   */
  reasonCode?: AttemptFailureReasonCode;
  /** True when every compatible model on the fallback ladder was tried. */
  exhausted?: boolean;
  /**
   * How many models that ladder actually tried. On a one-model platform (iOS,
   * or an f16-less low-memory Android) it is exactly one, and saying "we tried
   * a few options" would be a small lie. 0 / omitted = unknown.
   */
  triedModelCount?: number;
  onTryAgain(): void;
  onTellUsMore(): void;
};

/**
 * A storage shortage is a different failure: the fix is freeing space, not
 * retrying or waiting. Detected from the (factual) failure reason so we don't
 * tell someone whose disk is full to "try again later".
 */
function looksLikeStorageShortage(reason: string): boolean {
  return /free space|storage|not enough room|disk space/i.test(reason);
}

/**
 * Network- or host-shaped failure. A host 500 surfaces as `HTTP 500 fetching …`
 * and a dropped connection as `Network error streaming …`, so the same keywords
 * catch both. We reuse this in the exhausted branch too: once the ladder is
 * spent, blaming device luck for what was really a hosting/connectivity failure
 * ("this can happen on some devices") is a mild dishonesty — name the real cause.
 */
function looksLikeNetworkOrHosting(reason: string): boolean {
  return /network|fetch|download|offline|connection|dns|http/i.test(reason);
}

/**
 * Structured code first, text second.
 *
 * A code is a fact the failure origin reported; the regexes above are a guess at
 * a string that may not even be the failure text any more (the exhausted path
 * substitutes written copy). So when a code is present it decides on its own —
 * including deciding AGAINST the other branch — and the sniffers only run for
 * the paths that carry no code (bootstrap, device probe, model selection).
 */
function isStorageShortage(reason: string, reasonCode?: AttemptFailureReasonCode): boolean {
  return reasonCode ? reasonCode === 'insufficient-storage' : looksLikeStorageShortage(reason);
}

function isNetworkOrHosting(reason: string, reasonCode?: AttemptFailureReasonCode): boolean {
  return reasonCode ? reasonCode === 'network-or-host' : looksLikeNetworkOrHosting(reason);
}

/**
 * The headline owns the honesty: once the ladder is exhausted we have
 * already tried every option, so the copy must NOT imply a quick retry
 * will fix it. The non-exhausted case keeps the calmer "trouble right now".
 *
 * It also has to be honest about HOW MUCH we tried. Some platforms ship a
 * single compatible model (iOS; f16-less low-memory Android), so the ladder
 * there is one model long — "a few options" would be a claim about effort we
 * did not make. An unknown count keeps the plural line, which is what the
 * multi-model desktop ladder does.
 */
function headlineFor(
  reason: string,
  exhausted: boolean,
  triedModelCount: number,
  reasonCode?: AttemptFailureReasonCode,
): string {
  if (isStorageShortage(reason, reasonCode)) {
    return 'Eco needs a little more free space to set up on this device.';
  }
  if (!exhausted) {
    return "We're having trouble setting up your AI right now.";
  }
  return triedModelCount === 1
    ? "We couldn't get Eco's model running on this device just yet."
    : "We tried a few options and couldn't get one running on this device just yet.";
}

/**
 * The subtitle stays calm and non-technical, but it must be FACTUAL.
 * A storage shortage gets the reason verbatim (already plain language with the
 * numbers) plus the actionable next step. When exhausted, a network/host-shaped
 * failure gets a connectivity-honest line (not "some devices" — the host, not
 * the device, was the problem); otherwise point at the copy-and-send path
 * instead of over-promising a retry. Non-exhausted, only blame the network when
 * the failure reason actually looks network-shaped — asserting "probably a
 * network issue" for a local load timeout teaches users to distrust the message
 * (and their wifi).
 */
function subtitleFor(
  reason: string,
  exhausted: boolean,
  reasonCode?: AttemptFailureReasonCode,
): string {
  if (isStorageShortage(reason, reasonCode)) {
    return `${reason} Free up some space and try again.`;
  }
  if (exhausted) {
    return isNetworkOrHosting(reason, reasonCode)
      ? "We couldn't reach the model host just now — check your connection and try again in a bit."
      : 'This can happen on some devices. You can copy what happened and send it to us, or try again later.';
  }
  return isNetworkOrHosting(reason, reasonCode)
    ? 'This is probably a network issue.'
    : 'Something interrupted the setup — trying again usually fixes it.';
}

export function SetupErrorState({
  reason,
  reasonCode,
  exhausted = false,
  triedModelCount = 0,
  onTryAgain,
  onTellUsMore,
}: SetupErrorStateProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    try {
      // exportDiagnostics is privacy-safe (device class / timings / error
      // only — no conversation or file content) and stays entirely on-device:
      // the JSON goes to the clipboard, never to the network.
      const json = await exportDiagnostics();
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Best-effort; the "Tell us more" page also exposes Copy/Download.
    }
  };

  return (
    <main
      data-eco-setup-error-surface
      className="min-h-screen w-full flex flex-col items-center justify-center px-6 py-12"
      style={{
        background: 'var(--eco-surface)',
        color: 'var(--eco-text)',
        fontFamily: 'var(--eco-font-body)',
      }}
    >
      <div className="flex flex-col items-center text-center max-w-md w-full gap-8">
        <div
          role="img"
          aria-label="Illustration of a wilted plant — Eco couldn't finish setup right now."
          className="flex h-44 w-44 items-center justify-center rounded-3xl border border-[var(--eco-border)]/60"
          style={{ background: 'var(--eco-surface-elevated)' }}
        >
          <WiltedPlant size={140} className="text-[var(--eco-text-secondary)]" />
        </div>

        <h1 className="font-display text-3xl tracking-tight">Eco</h1>

        <p className="text-base leading-relaxed" style={{ color: 'var(--eco-text)' }}>
          {headlineFor(reason, exhausted, triedModelCount, reasonCode)}
          <br />
          {subtitleFor(reason, exhausted, reasonCode)}
        </p>

        <div className="flex flex-row flex-wrap justify-center gap-3">
          <Button onClick={onTryAgain} variant="primary" aria-label="Try setting up Eco again">
            Try again
          </Button>
          <Button onClick={handleCopy} variant="secondary">
            {copied ? 'Copied' : 'Copy what happened'}
          </Button>
          <Button onClick={onTellUsMore} variant="secondary" aria-label="Open diagnostic info">
            Tell us more
          </Button>
        </div>
      </div>
    </main>
  );
}
