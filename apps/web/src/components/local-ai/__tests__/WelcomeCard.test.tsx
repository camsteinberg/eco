// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WelcomeCard, WELCOME_CARD_OPEN_CLASS } from '../WelcomeCard';

const CHOICES = [
  { id: 'fast', name: 'Eco Fast', sizeLabel: '~0.8 GB', tagline: 'Smaller and faster.', speed: 4, depth: 2 },
  { id: 'deeper', name: 'Eco Deeper', sizeLabel: '~1.7 GB', tagline: 'Bigger and slower.', speed: 2, depth: 4 },
];

describe('WelcomeCard', () => {
  it('marks <html> while open so the phone cookie notice stays off the Start button, and cleans up', () => {
    // Measured at 390×844: the notice's fixed bar sat directly over "Start with
    // Eco Fast" on load (CTA y≈760, notice y≈783). The reservation padding only
    // lengthens the scroll run on an overflowing viewport, so the notice itself
    // must yield while the dialog is up.
    const { unmount } = render(
      <WelcomeCard choices={CHOICES} recommendedId="fast" onChoose={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /start with eco fast/i })).toBeInTheDocument();
    expect(document.documentElement.classList.contains(WELCOME_CARD_OPEN_CLASS)).toBe(true);
    unmount();
    expect(document.documentElement.classList.contains(WELCOME_CARD_OPEN_CLASS)).toBe(false);
  });
});
