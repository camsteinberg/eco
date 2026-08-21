// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { LocalAiStoragePanel } from '../LocalAiStoragePanel';
import type { StorageBreakdown } from '../../../hooks/local-ai/useLocalAiStorageBreakdown';
import type { Slot } from '../../../local-ai/types';

const ONE_GB = 1024 * 1024 * 1024;

const POPULATED: StorageBreakdown = {
  browserUsage: 3 * ONE_GB,
  browserQuota: 18 * ONE_GB,
  ecoTotalBytes: 2 * ONE_GB,
  measured: true,
  models: [
    { id: 'candidate/lfm2.5-1.2b-instruct-onnx', friendlyName: 'LFM2.5 1.2B', vendor: 'Liquid AI', sizeBytes: 0.76 * ONE_GB },
    { id: 'local/qwen3-0.6b', friendlyName: 'Qwen3 0.6B', vendor: 'Hugging Face', sizeBytes: 0.6 * ONE_GB },
  ],
};

/** The two cached models above, one per slot — the shipping pair. */
const BOUND_PAIR: Record<Slot, string | null> = {
  'eco-fast': 'local/qwen3-0.6b',
  'eco-smart': 'candidate/lfm2.5-1.2b-instruct-onnx',
};

const NOTHING_BOUND: Record<Slot, string | null> = {
  'eco-fast': null,
  'eco-smart': null,
};

const EMPTY: StorageBreakdown = {
  browserUsage: 50_000_000,
  browserQuota: 18 * ONE_GB,
  ecoTotalBytes: 0,
  measured: true,
  models: [],
};

describe('LocalAiStoragePanel — populated state', () => {
  // The panel's only mount is inside the Eco tab's "Storage on this device"
  // section, which supplies the heading. A heading here too printed the title
  // twice, one directly under the other.
  it('renders no heading of its own — the settings section owns the title', () => {
    render(
      <LocalAiStoragePanel
        status="ready"
        breakdown={POPULATED}
        slotModelIds={BOUND_PAIR}
        onClearModel={async () => undefined}
      />,
    );
    expect(screen.getByTestId('local-ai-storage-panel')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByText(/Storage on this device/i)).toBeNull();
    // The region stays named for assistive tech.
    expect(screen.getByLabelText('Local AI storage')).toBeInTheDocument();
  });

  it('renders one card per cached model with vendor + formatted size', () => {
    render(
      <LocalAiStoragePanel
        status="ready"
        breakdown={POPULATED}
        slotModelIds={BOUND_PAIR}
        onClearModel={async () => undefined}
      />,
    );
    expect(screen.getByText('LFM2.5 1.2B')).toBeInTheDocument();
    expect(screen.getByText('Qwen3 0.6B')).toBeInTheDocument();

    const lfmCard = screen.getByTestId('storage-model-card-candidate/lfm2.5-1.2b-instruct-onnx');
    expect(lfmCard).toHaveTextContent(/Made by Liquid AI/);
    expect(lfmCard).toHaveTextContent(/778 MB/);

    const bonsaiCard = screen.getByTestId('storage-model-card-local/qwen3-0.6b');
    expect(bonsaiCard).toHaveTextContent(/Made by Hugging Face/);
    // formatBytes uses MB below 1024^3 — 0.6 GiB ≈ 614 MB.
    expect(bonsaiCard).toHaveTextContent(/614 MB/);
  });

  it('soil bar has an aria-label summarizing Eco and browser usage', () => {
    render(
      <LocalAiStoragePanel
        status="ready"
        breakdown={POPULATED}
        slotModelIds={BOUND_PAIR}
        onClearModel={async () => undefined}
      />,
    );
    const bar = screen.getByRole('img', { name: /Eco models use 2\.0 GB.*out of 18\.0 GB/ });
    expect(bar).toBeInTheDocument();
  });

  it('Remove button enters a confirm step instead of clearing immediately', () => {
    const clear = vi.fn(async () => undefined);
    render(
      <LocalAiStoragePanel
        status="ready"
        breakdown={POPULATED}
        slotModelIds={BOUND_PAIR}
        onClearModel={clear}
      />,
    );
    fireEvent.click(screen.getByLabelText(/Remove LFM2.5 1.2B from this device/i));
    expect(clear).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: /Confirm removing LFM2.5 1.2B/i }),
    ).toBeInTheDocument();
  });

  it('confirming removal calls onClearModel with the model id', async () => {
    const clear = vi.fn(async () => undefined);
    render(
      <LocalAiStoragePanel
        status="ready"
        breakdown={POPULATED}
        slotModelIds={BOUND_PAIR}
        onClearModel={clear}
      />,
    );
    fireEvent.click(screen.getByLabelText(/Remove LFM2.5 1.2B from this device/i));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Confirm removing LFM2.5 1.2B/i }));
    });
    expect(clear).toHaveBeenCalledWith('candidate/lfm2.5-1.2b-instruct-onnx');
  });

  it('Cancel dismisses the confirm step without clearing', () => {
    const clear = vi.fn(async () => undefined);
    render(
      <LocalAiStoragePanel
        status="ready"
        breakdown={POPULATED}
        slotModelIds={BOUND_PAIR}
        onClearModel={clear}
      />,
    );
    fireEvent.click(screen.getByLabelText(/Remove LFM2.5 1.2B from this device/i));
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(clear).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: /Confirm removing LFM2.5 1.2B/i }),
    ).toBeNull();
  });
});

// A flat list could not answer the question the panel exists for on a two-model
// device: which of these is my device actually using? The cards are grouped by
// the slot that holds them, with anything cached but unbound gathered last.
describe('LocalAiStoragePanel — grouped by slot', () => {
  function renderWith(bindings: Record<Slot, string | null>) {
    render(
      <LocalAiStoragePanel
        status="ready"
        breakdown={POPULATED}
        slotModelIds={bindings}
        onClearModel={async () => undefined}
      />,
    );
  }

  it('puts each bound model in its slot group, in slot order', () => {
    renderWith(BOUND_PAIR);

    const groups = screen.getAllByTestId(/^storage-group-/);
    expect(groups.map((group) => group.dataset.testid)).toEqual([
      'storage-group-eco-fast',
      'storage-group-eco-smart',
    ]);
    expect(screen.getByTestId('storage-group-eco-fast')).toHaveTextContent('Qwen3 0.6B');
    expect(screen.getByTestId('storage-group-eco-smart')).toHaveTextContent('LFM2.5 1.2B');
  });

  it('labels the groups with the slots own names', () => {
    renderWith(BOUND_PAIR);

    expect(screen.getByTestId('storage-group-eco-fast')).toHaveTextContent('Instant start');
    expect(screen.getByTestId('storage-group-eco-smart')).toHaveTextContent('Main model');
  });

  it('gathers cached-but-unbound models last, under their own label', () => {
    renderWith({ 'eco-fast': 'local/qwen3-0.6b', 'eco-smart': null });

    const groups = screen.getAllByTestId(/^storage-group-/);
    expect(groups.map((group) => group.dataset.testid)).toEqual([
      'storage-group-eco-fast',
      'storage-group-other',
    ]);
    const other = screen.getByTestId('storage-group-other');
    expect(other).toHaveTextContent('Other downloads');
    expect(other).toHaveTextContent('LFM2.5 1.2B');
  });

  it('drops a slot group with nothing cached in it, rather than heading an absence', () => {
    renderWith({ 'eco-fast': null, 'eco-smart': 'candidate/lfm2.5-1.2b-instruct-onnx' });

    expect(screen.queryByTestId('storage-group-eco-fast')).toBeNull();
    expect(screen.getByTestId('storage-group-eco-smart')).toHaveTextContent('LFM2.5 1.2B');
    expect(screen.getByTestId('storage-group-other')).toHaveTextContent('Qwen3 0.6B');
  });

  it('keeps every card removable inside its group', () => {
    renderWith(BOUND_PAIR);

    expect(screen.getAllByLabelText(/Remove .* from this device/)).toHaveLength(2);
  });
});

describe('LocalAiStoragePanel — empty state', () => {
  it('shows the botanical empty-state message when no models cached', () => {
    render(
      <LocalAiStoragePanel
        status="ready"
        breakdown={EMPTY}
        slotModelIds={NOTHING_BOUND}
        onClearModel={async () => undefined}
      />,
    );
    expect(screen.getByText(/Nothing cached on this device yet/i)).toBeInTheDocument();
    expect(screen.queryAllByLabelText(/Remove .* from this device/)).toHaveLength(0);
  });

  it('soil bar still renders with full available capacity in the aria label', () => {
    render(
      <LocalAiStoragePanel
        status="ready"
        breakdown={EMPTY}
        slotModelIds={NOTHING_BOUND}
        onClearModel={async () => undefined}
      />,
    );
    const bar = screen.getByRole('img', { name: /Eco models use 0 B/ });
    expect(bar).toBeInTheDocument();
  });
});

describe('LocalAiStoragePanel — loading + missing-data', () => {
  it('renders a skeleton when status is loading and no breakdown yet', () => {
    render(
      <LocalAiStoragePanel
        status="loading"
        breakdown={null}
        slotModelIds={NOTHING_BOUND}
        onClearModel={async () => undefined}
      />,
    );
    expect(screen.getByText(/Measuring storage/i)).toBeInTheDocument();
  });

  it('falls back to ecoTotalBytes when browser quota is unknown', () => {
    const noQuota: StorageBreakdown = {
      browserUsage: null,
      browserQuota: null,
      ecoTotalBytes: 500_000_000,
      measured: true,
      models: [
        { id: 'local/x', friendlyName: 'Test', vendor: 'Anyone', sizeBytes: 500_000_000 },
      ],
    };
    render(
      <LocalAiStoragePanel
        status="ready"
        breakdown={noQuota}
        slotModelIds={NOTHING_BOUND}
        onClearModel={async () => undefined}
      />,
    );
    // No "available" or "used overall" label when both browserUsage and
    // browserQuota are null — the bar caption stays minimal.
    expect(screen.queryByText(/available/i)).toBeNull();
    expect(screen.queryByText(/used overall/i)).toBeNull();
    // 477 MB appears in both the soil-bar caption and the model card
    // (both showing the only cached model's bytes).
    expect(screen.getAllByText(/477 MB/).length).toBeGreaterThanOrEqual(1);
    const card = screen.getByTestId('storage-model-card-local/x');
    expect(card).toHaveTextContent(/477 MB/);
  });
});

// "Nothing cached" is a confident claim — when the Cache API could not even be
// asked, the panel must say it could not check, not assert emptiness while
// gigabytes sit on disk (measured live 2026-08-05).
describe('LocalAiStoragePanel — unmeasurable storage', () => {
  it('does not claim "Nothing cached" when storage could not be measured', () => {
    const unmeasured: StorageBreakdown = {
      browserUsage: 1_600_000_000,
      browserQuota: 12 * ONE_GB,
      ecoTotalBytes: 0,
      models: [],
      measured: false,
    };
    render(
      <LocalAiStoragePanel
        status="ready"
        breakdown={unmeasured}
        slotModelIds={NOTHING_BOUND}
        onClearModel={async () => undefined}
      />,
    );
    expect(screen.queryByText(/Nothing cached on this device yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/couldn.t check storage/i)).toBeInTheDocument();
  });
});
