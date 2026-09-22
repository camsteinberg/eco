// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { WelcomeCard } from '../WelcomeCard';

const CHOICES = [
  { id: 'fast', name: 'Eco Fast', sizeLabel: '~0.8 GB', tagline: 'Smaller and faster.', speed: 4, depth: 2 },
  { id: 'deeper', name: 'Eco Deeper', sizeLabel: '~1.7 GB', tagline: 'Bigger and slower.', speed: 2, depth: 4 },
];

describe('WelcomeCard', () => {
  it('renders each choice with a Start action for the recommended one', () => {
    render(<WelcomeCard choices={CHOICES} recommendedId="fast" onChoose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /start with eco fast/i })).toBeInTheDocument();
    expect(screen.getByText(/eco deeper/i)).toBeInTheDocument();
  });

  it.each(['fast', 'deeper'])('preselects and badges the recommended tile (%s), not a fixed position', (id) => {
    render(<WelcomeCard choices={CHOICES} recommendedId={id} onChoose={vi.fn()} />);
    const name = id === 'fast' ? /eco fast/i : /eco deeper/i;
    const other = id === 'fast' ? /eco deeper/i : /eco fast/i;
    const tile = screen.getByRole('radio', { name });
    expect(tile).toHaveAttribute('aria-checked', 'true');
    expect(within(tile).getByText('Recommended')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: other })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getAllByText('Recommended')).toHaveLength(1);
  });
});
