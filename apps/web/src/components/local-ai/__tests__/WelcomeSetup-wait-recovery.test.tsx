// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../../lib/billing-ui-gate', () => ({
  isBillingUiEnabled: () => false,
}));

import { WelcomeSetup, WAIT_RECOVERY_MS } from '../WelcomeSetup';

describe('WelcomeSetup — wait-bucket recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // T1: Latched 'hour' + measured 'minutes' sustained 60 s → recovers.
  it('recovers from "hour" to "minutes" after 60 s of sustained better measurement', () => {
    const { rerender } = render(
      <WelcomeSetup phase="downloading" percent={3} etaSeconds={70 * 60} reassuranceIndex={0} />,
    );
    expect(screen.getByText(/an hour or more/i)).toBeInTheDocument();

    // First rerender with minutes — starts the clock, but no recovery yet.
    rerender(
      <WelcomeSetup phase="downloading" percent={10} etaSeconds={4 * 60} reassuranceIndex={0} />,
    );
    expect(screen.getByText(/an hour or more/i)).toBeInTheDocument();

    // Advance past recovery threshold and rerender with the same better ETA.
    vi.advanceTimersByTime(WAIT_RECOVERY_MS);
    rerender(
      <WelcomeSetup phase="downloading" percent={15} etaSeconds={4 * 60} reassuranceIndex={0} />,
    );
    expect(screen.getByText(/takes a few minutes/i)).toBeInTheDocument();
    expect(screen.queryByText(/an hour or more/i)).not.toBeInTheDocument();
  });

  // T2: Latched 'hour' + measured 'minutes' for 30 s then 'hour' again → stays "hour".
  it('resets the recovery clock when the measured bucket worsens mid-recovery', () => {
    const { rerender } = render(
      <WelcomeSetup phase="downloading" percent={3} etaSeconds={70 * 60} reassuranceIndex={0} />,
    );
    expect(screen.getByText(/an hour or more/i)).toBeInTheDocument();

    // 30 s of better measurement — not enough.
    rerender(
      <WelcomeSetup phase="downloading" percent={10} etaSeconds={4 * 60} reassuranceIndex={0} />,
    );
    vi.advanceTimersByTime(30_000);
    rerender(
      <WelcomeSetup phase="downloading" percent={12} etaSeconds={4 * 60} reassuranceIndex={0} />,
    );
    expect(screen.getByText(/an hour or more/i)).toBeInTheDocument();

    // Measurement worsens — clock resets.
    rerender(
      <WelcomeSetup phase="downloading" percent={13} etaSeconds={70 * 60} reassuranceIndex={0} />,
    );
    expect(screen.getByText(/an hour or more/i)).toBeInTheDocument();

    // Another 60 s of better measurement after the reset — should NOT recover
    // because the clock restarted.
    rerender(
      <WelcomeSetup phase="downloading" percent={14} etaSeconds={4 * 60} reassuranceIndex={0} />,
    );
    vi.advanceTimersByTime(WAIT_RECOVERY_MS - 1);
    rerender(
      <WelcomeSetup phase="downloading" percent={15} etaSeconds={4 * 60} reassuranceIndex={0} />,
    );
    expect(screen.getByText(/an hour or more/i)).toBeInTheDocument();
  });

  // T3: Brief better burst (< 60 s) never changes the line.
  it('does not recover on a brief better burst shorter than 60 s', () => {
    const { rerender } = render(
      <WelcomeSetup phase="downloading" percent={3} etaSeconds={70 * 60} reassuranceIndex={0} />,
    );
    expect(screen.getByText(/an hour or more/i)).toBeInTheDocument();

    // A 59 s burst of better measurement.
    rerender(
      <WelcomeSetup phase="downloading" percent={10} etaSeconds={4 * 60} reassuranceIndex={0} />,
    );
    vi.advanceTimersByTime(WAIT_RECOVERY_MS - 1);
    rerender(
      <WelcomeSetup phase="downloading" percent={15} etaSeconds={4 * 60} reassuranceIndex={0} />,
    );
    expect(screen.getByText(/an hour or more/i)).toBeInTheDocument();
    expect(screen.queryByText(/takes a few minutes/i)).not.toBeInTheDocument();
  });

  // T4: Measured 'unknown' (etaSeconds 0/undefined) for any duration → no recovery.
  it('does not recover when measured bucket is unknown (etaSeconds 0)', () => {
    const { rerender } = render(
      <WelcomeSetup phase="downloading" percent={3} etaSeconds={70 * 60} reassuranceIndex={0} />,
    );
    expect(screen.getByText(/an hour or more/i)).toBeInTheDocument();

    // etaSeconds = 0 → 'unknown', which should never count as better.
    rerender(
      <WelcomeSetup phase="downloading" percent={10} etaSeconds={0} reassuranceIndex={0} />,
    );
    vi.advanceTimersByTime(WAIT_RECOVERY_MS * 2);
    rerender(
      <WelcomeSetup phase="downloading" percent={15} etaSeconds={0} reassuranceIndex={0} />,
    );
    expect(screen.getByText(/an hour or more/i)).toBeInTheDocument();
  });

  it('does not recover when measured bucket is unknown (etaSeconds undefined)', () => {
    const { rerender } = render(
      <WelcomeSetup phase="downloading" percent={3} etaSeconds={70 * 60} reassuranceIndex={0} />,
    );
    expect(screen.getByText(/an hour or more/i)).toBeInTheDocument();

    rerender(
      <WelcomeSetup phase="downloading" percent={10} etaSeconds={undefined} reassuranceIndex={0} />,
    );
    vi.advanceTimersByTime(WAIT_RECOVERY_MS * 2);
    rerender(
      <WelcomeSetup phase="downloading" percent={15} etaSeconds={undefined} reassuranceIndex={0} />,
    );
    expect(screen.getByText(/an hour or more/i)).toBeInTheDocument();
  });

  // T5: Worse measured bucket still applies immediately (ratchet-up pinned).
  it('ratchets up to a worse bucket immediately', () => {
    const { rerender } = render(
      <WelcomeSetup phase="downloading" percent={10} etaSeconds={4 * 60} reassuranceIndex={0} />,
    );
    expect(screen.getByText(/takes a few minutes/i)).toBeInTheDocument();

    // Jump straight to 'hour' — no 60 s delay.
    rerender(
      <WelcomeSetup phase="downloading" percent={3} etaSeconds={70 * 60} reassuranceIndex={0} />,
    );
    expect(screen.getByText(/an hour or more/i)).toBeInTheDocument();
  });
});
