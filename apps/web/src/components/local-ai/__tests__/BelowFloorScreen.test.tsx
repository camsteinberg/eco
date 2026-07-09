// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BelowFloorScreen } from '../BelowFloorScreen';

const noopSignup = (): Promise<void> => Promise.resolve();

describe('BelowFloorScreen — honest device-capability messaging', () => {
  it('states honestly that the browser does not yet fully support on-device Eco', () => {
    // Launch-trust: a below-floor device must be told the truth — Eco runs on the
    // device and this browser cannot fully do that yet — not shown a chat surface
    // it cannot use or an overclaim that it works.
    render(<BelowFloorScreen deviceLabel="Safari on iPhone" onSignup={noopSignup} />);

    expect(screen.getByText(/doesn't fully support that yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Safari on iPhone/)).toBeInTheDocument();
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

  it('renders the honest message even when no device label is available', () => {
    render(<BelowFloorScreen onSignup={vi.fn()} />);

    expect(screen.getByText(/doesn't fully support that yet/i)).toBeInTheDocument();
  });

  it('keeps a space between "browser" and "doesn\'t" on the no-label path', () => {
    // Regression (Dim B PR-B3): when no deviceLabel is supplied the conditional
    // interpolation collapses to '' and JSX whitespace-trimming used to fuse the
    // words into "browserdoesn't". The unknown-device path is exactly the common
    // case (e.g. a browser with no WebGPU adapter), so the copy must read cleanly.
    render(<BelowFloorScreen onSignup={vi.fn()} />);

    expect(
      screen.getByText(/your browser doesn't fully support that yet/i),
    ).toBeInTheDocument();
  });

  it('reads correctly with a device label between "browser" and "doesn\'t"', () => {
    render(<BelowFloorScreen deviceLabel="Safari on iPhone" onSignup={noopSignup} />);

    expect(
      screen.getByText(/your browser \(Safari on iPhone\) doesn't fully support that yet/i),
    ).toBeInTheDocument();
  });
});
