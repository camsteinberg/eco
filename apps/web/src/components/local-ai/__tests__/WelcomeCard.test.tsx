// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
