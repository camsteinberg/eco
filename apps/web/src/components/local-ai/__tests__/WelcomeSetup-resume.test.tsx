// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../../lib/billing-ui-gate', () => ({
  isBillingUiEnabled: () => false,
}));

import { WelcomeSetup } from '../WelcomeSetup';

const RESUME_COPY = 'Last time got interrupted — picking up where we left off.';

describe('WelcomeSetup — #73 resume reassurance line', () => {
  it('shows the reassurance line when resuming (resumeModel set, no priorAttemptFailed)', () => {
    render(
      <WelcomeSetup
        phase="downloading"
        percent={40}
        etaSeconds={30}
        reassuranceIndex={0}
        resuming
      />,
    );
    expect(screen.getByText(RESUME_COPY)).toBeInTheDocument();
  });

  it('shows the reassurance line when priorAttemptFailed alone', () => {
    render(
      <WelcomeSetup
        phase="downloading"
        percent={20}
        etaSeconds={60}
        reassuranceIndex={0}
        priorAttemptFailed
      />,
    );
    expect(screen.getByText(RESUME_COPY)).toBeInTheDocument();
  });

  it('renders the reassurance line only ONCE when both resuming and priorAttemptFailed', () => {
    render(
      <WelcomeSetup
        phase="downloading"
        percent={30}
        etaSeconds={60}
        reassuranceIndex={0}
        resuming
        priorAttemptFailed
      />,
    );
    const matches = screen.getAllByText(RESUME_COPY);
    expect(matches).toHaveLength(1);
  });

  it('pins the exact copy string', () => {
    render(
      <WelcomeSetup
        phase="downloading"
        percent={40}
        etaSeconds={30}
        reassuranceIndex={0}
        resuming
      />,
    );
    expect(
      screen.getByText('Last time got interrupted — picking up where we left off.'),
    ).toBeInTheDocument();
  });
});
