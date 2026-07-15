// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BelowFloorScreen } from '../BelowFloorScreen';

const noopSignup = (): Promise<void> => Promise.resolve();

describe('BelowFloorScreen — honest device-capability messaging', () => {
  it('blames the browser only for the runtime reason (no WebGPU / no viable WASM)', () => {
    // Launch-trust: a runtime-below-floor device must be told the truth — Eco runs
    // on the device and this browser cannot do that yet — not shown a chat surface
    // it cannot use or an overclaim that it works.
    render(
      <BelowFloorScreen deviceLabel="Safari on iPhone" reason="runtime" onSignup={noopSignup} />,
    );

    expect(screen.getByText(/can't do that yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Safari on iPhone/)).toBeInTheDocument();
  });

  it('defaults to the runtime message when no reason is supplied', () => {
    render(<BelowFloorScreen onSignup={vi.fn()} />);

    expect(screen.getByText(/this browser can't do that yet/i)).toBeInTheDocument();
  });

  it('names memory (never the browser) for the memory reason', () => {
    // The device's browser is fine — the honest limit is memory. Blaming the
    // browser here is the lie this surface exists to fix.
    render(<BelowFloorScreen reason="memory" onSignup={noopSignup} />);

    expect(screen.getByText(/doesn't have enough memory/i)).toBeInTheDocument();
    expect(screen.getByText(/On a computer with more memory, Eco just works/i)).toBeInTheDocument();
    // The email promise pivots to the thing that would actually unblock them.
    expect(screen.getByText(/We'll email you when lighter models arrive\./i)).toBeInTheDocument();
  });

  it('never says "browser" on the memory reason', () => {
    // Guard for the specific untruth: a capable browser must not be told its
    // browser is at fault. Scope the assertion to the explanation + notify copy;
    // the "what works today" disclosure legitimately names browsers.
    render(<BelowFloorScreen reason="memory" onSignup={noopSignup} />);

    const explanation = screen.getByText(/doesn't have enough memory/i);
    expect(explanation.textContent).not.toMatch(/browser/i);

    const notify = screen.getByText(/We'll email you when lighter models arrive\./i);
    expect(notify.textContent).not.toMatch(/browser/i);
  });

  it('gives an honest "not ready for this setup" message for the fallback reason', () => {
    render(<BelowFloorScreen reason="fallback" onSignup={noopSignup} />);

    expect(screen.getByText(/isn't ready for this setup yet/i)).toBeInTheDocument();
    expect(screen.getByText(/We'll email you when Eco arrives\./i)).toBeInTheDocument();
  });

  it('discloses an accurate "what works today" capability matrix', () => {
    render(<BelowFloorScreen onSignup={noopSignup} />);

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
    render(<BelowFloorScreen reason="runtime" onSignup={vi.fn()} />);

    expect(screen.getByText(/this browser can't do that yet/i)).toBeInTheDocument();
  });

  it('keeps a space between "browser" and "can\'t" on the no-label runtime path', () => {
    // Regression (Dim B PR-B3): when no deviceLabel is supplied the conditional
    // interpolation collapses to '' and JSX whitespace-trimming used to fuse the
    // words into "browsercan't". The unknown-device path is exactly the common
    // case (e.g. a browser with no WebGPU adapter), so the copy must read cleanly.
    render(<BelowFloorScreen reason="runtime" onSignup={vi.fn()} />);

    expect(
      screen.getByText(/this browser can't do that yet/i),
    ).toBeInTheDocument();
  });

  it('reads correctly with a device label between "browser" and "can\'t"', () => {
    render(
      <BelowFloorScreen deviceLabel="Safari on iPhone" reason="runtime" onSignup={noopSignup} />,
    );

    expect(
      screen.getByText(/this browser \(Safari on iPhone\) can't do that yet/i),
    ).toBeInTheDocument();
  });
});
