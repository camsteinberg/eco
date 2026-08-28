// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DemotionDivider } from '../DemotionDivider';

describe('DemotionDivider', () => {
  it('renders the exact spec copy with the provided labels', () => {
    render(
      <DemotionDivider fromLabel="Eco Fast" toLabel="Eco Light" />,
    );
    expect(
      screen.getByText(
        /Answering with Eco Light — a smaller model — because Eco Fast couldn't start on this device right now\. You can get Eco Fast back in Settings\./,
      ),
    ).toBeInTheDocument();
  });

  it('does not expose raw model ids in the rendered output', () => {
    render(
      <DemotionDivider fromLabel="Eco Fast" toLabel="Eco Light" />,
    );
    expect(screen.queryByText(/candidate\//)).toBeNull();
    expect(screen.queryByText(/lfm2/)).toBeNull();
    expect(screen.queryByText(/onnx/)).toBeNull();
  });

  it('uses the separator role like OfflineDivider', () => {
    render(
      <DemotionDivider fromLabel="Eco Fast" toLabel="Eco Light" />,
    );
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });
});
