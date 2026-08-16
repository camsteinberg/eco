// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BelowFloorScreen } from '../BelowFloorScreen';

describe('BelowFloorScreen — honest device-capability messaging', () => {
  it('blames the browser only for the runtime reason (no WebGPU / no viable WASM)', () => {
    // Launch-trust: a runtime-below-floor device must be told the truth — Eco runs
    // on the device and this browser cannot do that yet — not shown a chat surface
    // it cannot use or an overclaim that it works.
    render(<BelowFloorScreen deviceLabel="Safari on iPhone" reason="runtime" />);

    expect(screen.getByText(/can't do that yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Safari on iPhone/)).toBeInTheDocument();
  });

  it('defaults to the runtime message when no reason is supplied', () => {
    render(<BelowFloorScreen />);

    expect(screen.getByText(/this browser can't do that yet/i)).toBeInTheDocument();
  });

  it('names memory (never the browser) for the memory reason', () => {
    // The device's browser is fine — the honest limit is memory. Blaming the
    // browser here is the lie this surface exists to fix.
    render(<BelowFloorScreen reason="memory" />);

    expect(screen.getByText(/doesn't have enough memory/i)).toBeInTheDocument();
    expect(screen.getByText(/On a computer with more memory, Eco just works/i)).toBeInTheDocument();
    // The handoff promise pivots to the thing that would actually unblock them.
    expect(
      screen.getByText(/Email us and we'll tell you when lighter models arrive\./i),
    ).toBeInTheDocument();
  });

  it('never says "browser" on the memory reason', () => {
    // Guard for the specific untruth: a capable browser must not be told its
    // browser is at fault. Scope the assertion to the explanation + handoff copy;
    // the "what works today" disclosure legitimately names browsers.
    render(<BelowFloorScreen reason="memory" />);

    const explanation = screen.getByText(/doesn't have enough memory/i);
    expect(explanation.textContent).not.toMatch(/browser/i);

    const notify = screen.getByText(/Email us and we'll tell you when lighter models arrive\./i);
    expect(notify.textContent).not.toMatch(/browser/i);
  });

  it('gives an honest "not ready for this setup" message for the fallback reason', () => {
    render(<BelowFloorScreen reason="fallback" />);

    expect(screen.getByText(/isn't ready for this setup yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Email us and we'll tell you when Eco is ready for this setup\./i),
    ).toBeInTheDocument();
  });

  it('discloses an accurate "what works today" capability matrix', () => {
    render(<BelowFloorScreen />);

    // The capability list is collapsed until the user opts to see it.
    expect(screen.queryByText(/Eco runs today on:/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /what works today/i }));

    // The disclosed posture is honest about which runtimes work where: WebGPU on
    // Chrome/Edge, and the slower WebAssembly path (limited models) on Safari/Firefox.
    expect(screen.getByText(/Chrome \/ Edge.*WebGPU/i)).toBeInTheDocument();
    expect(screen.getByText(/Safari on a Mac \(limited models, WebAssembly mode\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Firefox on a desktop \(limited models, WebAssembly mode\)/i)).toBeInTheDocument();
  });

  it('renders the runtime message even when no device label is available', () => {
    render(<BelowFloorScreen reason="runtime" />);

    expect(screen.getByText(/this browser can't do that yet/i)).toBeInTheDocument();
  });

  it('keeps a space between "browser" and "can\'t" on the no-label runtime path', () => {
    // Regression (Dim B PR-B3): when no deviceLabel is supplied the conditional
    // interpolation collapses to '' and JSX whitespace-trimming used to fuse the
    // words into "browsercan't". The unknown-device path is exactly the common
    // case (e.g. a browser with no WebGPU adapter), so the copy must read cleanly.
    render(<BelowFloorScreen reason="runtime" />);

    expect(screen.getByText(/this browser can't do that yet/i)).toBeInTheDocument();
  });

  it('reads correctly with a device label between "browser" and "can\'t"', () => {
    render(<BelowFloorScreen deviceLabel="Safari on iPhone" reason="runtime" />);

    expect(
      screen.getByText(/this browser \(Safari on iPhone\) can't do that yet/i),
    ).toBeInTheDocument();
  });
});

describe('BelowFloorScreen — Email us handoff (MC-1, no fake capture)', () => {
  it('is a real mailto to hello@econetwork.ai, prefilled with device context', () => {
    // The honest handoff: a real <a> mailto — the user's OWN mail client supplies
    // their address, and we carry the device/reason so we can actually follow up.
    // Nothing on this screen captures or stores anything.
    render(<BelowFloorScreen deviceLabel="Firefox on Linux" reason="runtime" />);

    const href = screen.getByRole('link', { name: /email us/i }).getAttribute('href') ?? '';
    expect(href).toMatch(/^mailto:hello@econetwork\.ai\?/);
    const decoded = decodeURIComponent(href);
    expect(decoded).toContain('Device: Firefox on Linux');
    expect(decoded).toContain('Reason: runtime');
  });

  it('presents no email field and no waitlist promise (the MC-1 honesty fix)', () => {
    // The old fake-capture apparatus is gone: no email input (which implied a
    // stored list), no "Sign me up", no passive "we'll let you know".
    render(<BelowFloorScreen reason="runtime" />);

    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/sign me up/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/we'll let you know/i)).not.toBeInTheDocument();
  });
});

describe('BelowFloorScreen — mobile designed tier (handoff surface)', () => {
  const ORIGINAL_SHARE = Object.getOwnPropertyDescriptor(navigator, 'share');
  const ORIGINAL_CLIPBOARD = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  afterEach(() => {
    // Restore/remove the navigator overrides so cases don't leak into each other.
    if (ORIGINAL_SHARE) Object.defineProperty(navigator, 'share', ORIGINAL_SHARE);
    else delete (navigator as { share?: unknown }).share;
    if (ORIGINAL_CLIPBOARD) Object.defineProperty(navigator, 'clipboard', ORIGINAL_CLIPBOARD);
    else delete (navigator as { clipboard?: unknown }).clipboard;
    vi.restoreAllMocks();
  });

  const setShare = (fn: unknown): void => {
    Object.defineProperty(navigator, 'share', { value: fn, configurable: true });
  };
  const setClipboard = (writeText: unknown): void => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  };

  it('tells the honest iOS story: Eco runs on iPhone, just not this one yet (HON-4)', () => {
    // Reconciled with diagnosis.ts: a below-floor iOS device is blocked by its own
    // capability (usually an iOS version without WebGPU), NOT because "phones don't
    // have the memory" — Eco ships a validated iPhone/iPad lane.
    delete (navigator as { share?: unknown }).share;
    render(<BelowFloorScreen reason="mobile" />);

    expect(screen.getByText(/Eco does run on iPhone and iPad/i)).toBeInTheDocument();
    expect(
      screen.getByText(/updating to the latest iOS is the most likely fix/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Email us and we'll tell you when this device is supported\./i),
    ).toBeInTheDocument();
  });

  it('speaks one honest voice: the illustration label matches the iOS stance', () => {
    // The aria-label must carry the same true stance as the body copy and
    // diagnosis.ts — Eco runs on iPhone/iPad, this one just can't yet.
    delete (navigator as { share?: unknown }).share;
    render(<BelowFloorScreen reason="mobile" />);

    expect(
      screen.getByRole('img', { name: /Eco runs on iPhone and iPad, just not this one yet\./i }),
    ).toBeInTheDocument();
  });

  it('routes the mobile Email us handoff to the phones context', () => {
    delete (navigator as { share?: unknown }).share;
    render(<BelowFloorScreen reason="mobile" />);

    const href = screen.getByRole('link', { name: /email us/i }).getAttribute('href') ?? '';
    expect(href).toMatch(/^mailto:hello@econetwork\.ai\?/);
    expect(decodeURIComponent(href)).toContain('Reason: mobile');
  });

  it('invokes the native share sheet when Web Share is available', () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setShare(share);
    render(<BelowFloorScreen reason="mobile" />);

    fireEvent.click(screen.getByRole('button', { name: /send eco to your computer/i }));
    expect(share).toHaveBeenCalledWith({ title: 'Eco', url: 'https://econetwork.ai' });
  });

  it('swallows a cancelled share (AbortError) without surfacing an error', async () => {
    const share = vi.fn().mockRejectedValue(
      Object.assign(new Error('cancelled'), { name: 'AbortError' }),
    );
    setShare(share);
    render(<BelowFloorScreen reason="mobile" />);

    fireEvent.click(screen.getByRole('button', { name: /send eco to your computer/i }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    // The button is still there; nothing broke and no error copy appeared.
    expect(screen.getByRole('button', { name: /send eco to your computer/i })).toBeInTheDocument();
  });

  it('keeps the handoff the only primary CTA — Email us drops to the secondary variant', () => {
    // Two stacked same-weight green buttons compete and dilute the handoff.
    // Force Web Share absent so the handoff renders as the "Copy link" primary,
    // then assert Email us is the quiet outline (secondary) @eco/ui variant.
    delete (navigator as { share?: unknown }).share;
    render(<BelowFloorScreen reason="mobile" />);

    const handoff = screen.getByRole('button', { name: /copy link/i });
    const emailUs = screen.getByRole('link', { name: /email us/i });

    // Primary (@eco/ui) fills the primary background; secondary is outline-only.
    expect(handoff.className).toContain('bg-[var(--eco-primary)]');
    expect(emailUs.className).toContain('border-[var(--eco-primary)]');
    expect(emailUs.className).not.toContain('bg-[var(--eco-primary)]');
  });

  it('keeps Email us primary on the non-mobile reasons (no competing CTA there)', () => {
    render(<BelowFloorScreen reason="runtime" />);
    const emailUs = screen.getByRole('link', { name: /email us/i });
    expect(emailUs.className).toContain('bg-[var(--eco-primary)]');
  });

  it('falls back to Copy link when Web Share is absent, confirming "Link copied"', async () => {
    delete (navigator as { share?: unknown }).share;
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    render(<BelowFloorScreen reason="mobile" />);

    const button = screen.getByRole('button', { name: /copy link/i });
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith('https://econetwork.ai');
    expect(await screen.findByText(/link copied/i)).toBeInTheDocument();
  });
});
