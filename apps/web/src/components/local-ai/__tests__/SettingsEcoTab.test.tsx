// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SettingsEcoTab } from '../SettingsEcoTab';
import { SETTINGS_STORAGE_SECTION_ID } from '../../settings/settingsNavigation';
import { useSettingsStore } from '../../../stores/settingsStore';
import type { ModelConfig, Slot } from '../../../local-ai/types';

// The tab hosts the guest data export, which reads the session. Signed-out is
// the default here; the member case flips this ref.
const sessionRef: { current: { user: { id: string } } | null } = { current: null };
vi.mock('../../../lib/auth', () => ({
  useSession: () => ({ data: sessionRef.current }),
}));
vi.mock('../../settings/DataExportButton', () => ({
  DataExportButton: () => <button type="button">Export my data</button>,
}));

const MODEL: ModelConfig = {
  id: 'local/qwen3-0.6b',
  friendlyName: 'Qwen3',
  vendor: 'Alibaba',
  sizeGB: 0.57,
  runtime: 'transformers',
  format: 'onnx-q4f16',
  capabilities: { intent: ['snappy', 'balanced'], tasks: ['chat', 'writing', 'reasoning'], contextTokens: 4096 },
  bestFor: 'Quick chat, short explanations, lightweight writing',
  knownLimitation: 'k',
  evidenceTier: 'proven',
};

/** The tab only forwards these to the storage panel, which groups by them. */
const SLOT_MODEL_IDS: Record<Slot, string | null> = {
  'eco-fast': 'local/qwen3-0.6b',
  'eco-smart': null,
};

describe('SettingsEcoTab — default state', () => {
  afterEach(() => {
    // Restore the default (off) so technical-details state doesn't leak.
    useSettingsStore.setState({ showTechnicalDetails: false });
  });

  it('renders the Your AI heading and Switch your AI button', () => {
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    expect(screen.getByRole('heading', { name: /^your ai$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /switch your ai/i })).toBeInTheDocument();
  });

  it('shows branded display name and quality phrase by default, but hides the mono provenance line', () => {
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    // Display-mapped names for Qwen3 (id: local/qwen3-0.6b)
    expect(screen.getByText('Eco Compact (Qwen)')).toBeInTheDocument();
    expect(screen.getByText('Small + capable · good for limited devices')).toBeInTheDocument();
    // Provenance (vendor · size) is a technical detail — hidden until the
    // user opts into technical details (C-08).
    expect(screen.queryByText(/Alibaba.*0\.6 GB/)).toBeNull();
  });

  it('reveals the mono provenance line when showTechnicalDetails is on', () => {
    useSettingsStore.setState({ showTechnicalDetails: true });
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    expect(screen.getByText(/Alibaba.*0\.6 GB/)).toBeInTheDocument();
  });

  it('does NOT show the technical model id by default', () => {
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    expect(screen.queryByText(MODEL.id)).toBeNull();
  });

  it('reveals the model id only after opening Show technical details', () => {
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    expect(screen.queryByText(MODEL.id)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /show technical details/i }));
    expect(screen.getByText(MODEL.id)).toBeInTheDocument();
  });

  // The section title and the panel's own heading both said "Storage on this
  // device", one directly under the other.
  it('prints the storage section title exactly once', () => {
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    expect(screen.getAllByText(/Storage on this device/i)).toHaveLength(1);
  });

});

describe('SettingsEcoTab — grounding toggle (#5 S5)', () => {
  afterEach(() => {
    // Restore the default (on) so the gate state doesn't leak between tests.
    useSettingsStore.setState({ groundingEnabled: true });
  });

  it('renders the web-lookups row with the accurate privacy copy', () => {
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    expect(screen.getByText('Look up facts from the web')).toBeInTheDocument();
    // The privacy framing is non-negotiable — assert the load-bearing claim.
    expect(
      screen.getByText(/Eco's servers never see your questions/i),
    ).toBeInTheDocument();
  });

  it('reflects the store value: ON by default (switch checked)', () => {
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    const toggle = screen.getByRole('switch', { name: /web fact lookups/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('reflects the store value: OFF when groundingEnabled is false', () => {
    useSettingsStore.setState({ groundingEnabled: false });
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    const toggle = screen.getByRole('switch', { name: /web fact lookups/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('flipping the toggle updates the store (ON → OFF)', () => {
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    const toggle = screen.getByRole('switch', { name: /web fact lookups/i });
    expect(useSettingsStore.getState().groundingEnabled).toBe(true);
    act(() => {
      fireEvent.click(toggle);
    });
    expect(useSettingsStore.getState().groundingEnabled).toBe(false);
  });
});

describe('SettingsEcoTab — empty state', () => {
  it('shows a Set up Eco prompt when no model is loaded', () => {
    render(
      <SettingsEcoTab
        currentModel={null}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    expect(screen.getByText(/Eco isn't set up/i)).toBeInTheDocument();
  });

  it('Set up Eco button triggers onSwitchAI callback', () => {
    const onSwitch = vi.fn();
    render(
      <SettingsEcoTab
        currentModel={null}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={onSwitch}
        onClearCache={async () => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /set up eco/i }));
    expect(onSwitch).toHaveBeenCalledOnce();
  });

  it('has aria-label indicating no model loaded', () => {
    render(
      <SettingsEcoTab
        currentModel={null}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    expect(screen.getByLabelText(/no model loaded/i)).toBeInTheDocument();
  });
});

describe('SettingsEcoTab — ready state with model', () => {
  it('shows Transformers.js v4 runtime in technical details for transformers models', () => {
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /show technical details/i }));
    expect(screen.getByText('Transformers.js v4')).toBeInTheDocument();
  });

  it('Switch your AI button triggers onSwitchAI callback', () => {
    const onSwitch = vi.fn();
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={onSwitch}
        onClearCache={async () => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /switch your ai/i }));
    expect(onSwitch).toHaveBeenCalledOnce();
  });

  it('shows a "Setting up on this device…" line when the model is still preparing', () => {
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        currentModelStatus="preparing"
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    expect(screen.getByText(/setting up on this device/i)).toBeInTheDocument();
  });

  it('omits the setting-up line when the model is ready', () => {
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        currentModelStatus="ready"
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    expect(screen.queryByText(/setting up on this device/i)).toBeNull();
  });
});

describe('SettingsEcoTab — storage', () => {
  it('renders the per-model storage panel', () => {
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    expect(screen.getByTestId('local-ai-storage-panel')).toBeInTheDocument();
  });

  // The storage section is the scroll target a "Free up space" deep link
  // (?tab=models&manage=storage) lands on, so it must carry the stable anchor id.
  it('gives the storage section the scroll-target anchor id', () => {
    const { container } = render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    const target = container.querySelector(`#${SETTINGS_STORAGE_SECTION_ID}`);
    expect(target).not.toBeNull();
    expect(target).toContainElement(screen.getByTestId('local-ai-storage-panel'));
  });
});

describe('SettingsEcoTab — optional callbacks', () => {
  it('renders Diagnostic info link when onShowDiagnostic provided', () => {
    const onDiag = vi.fn();
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
        onShowDiagnostic={onDiag}
      />,
    );
    const link = screen.getByText(/diagnostic info/i);
    fireEvent.click(link);
    expect(onDiag).toHaveBeenCalledOnce();
  });

  it('does not render Diagnostic info link when onShowDiagnostic omitted', () => {
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    expect(screen.queryByText(/diagnostic info/i)).toBeNull();
  });

  it('renders Switch off Eco when onSwitchOffEco provided (inside technical details)', () => {
    const onOff = vi.fn();
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
        onSwitchOffEco={onOff}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /show technical details/i }));
    const offBtn = screen.getByText(/switch off eco/i);
    fireEvent.click(offBtn);
    expect(onOff).toHaveBeenCalledOnce();
  });

  it('does not render Switch off Eco when onSwitchOffEco omitted', () => {
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => undefined}
        onClearCache={async () => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /show technical details/i }));
    expect(screen.queryByText(/switch off eco/i)).toBeNull();
  });
});

describe('SettingsEcoTab — your data (guest export)', () => {
  afterEach(() => {
    sessionRef.current = null;
  });

  it('gives a signed-out person a Your data section with the export button', () => {
    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => {}}
        onClearCache={async () => {}}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Your data' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export my data/i })).toBeInTheDocument();
  });

  it('offers the export before a model is set up too', () => {
    render(
      <SettingsEcoTab
        currentModel={null}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => {}}
        onClearCache={async () => {}}
      />,
    );

    expect(screen.getByRole('button', { name: /export my data/i })).toBeInTheDocument();
  });

  it('hides it from a member, who still has the export on the Account tab', () => {
    sessionRef.current = { user: { id: '1' } };

    render(
      <SettingsEcoTab
        currentModel={MODEL}
        storageBreakdown={null}
        storageStatus="loading"
        slotModelIds={SLOT_MODEL_IDS}
        onSwitchAI={() => {}}
        onClearCache={async () => {}}
      />,
    );

    expect(screen.queryByRole('heading', { name: 'Your data' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /export my data/i })).not.toBeInTheDocument();
  });
});
