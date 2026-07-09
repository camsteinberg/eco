// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * ModelUpgradeCard — the consent surfaces of the slice-2b upgrade.
 * Locks: consent actions are wired (accept/decline/swap/later), the swap
 * button is disabled mid-generation, honest deferral copy renders, and the
 * boost note auto-dismisses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ModelUpgradeCard } from '../ModelUpgradeCard';
import type { ModelConfig } from '../../../local-ai/types';
import type {
  ModelUpgradeUi,
  UseModelUpgradeReturn,
} from '../../../hooks/local-ai/useModelUpgrade';

const TARGET = {
  id: 'candidate/qwen3.5-2b-onnx',
  friendlyName: 'Qwen 3.5',
  sizeGB: 1.4,
} as unknown as ModelConfig;

function upgradeStub(ui: ModelUpgradeUi): UseModelUpgradeReturn {
  return {
    ui,
    accept: vi.fn(),
    decline: vi.fn(),
    notNow: vi.fn(),
    swapNow: vi.fn(),
    dismiss: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ModelUpgradeCard', () => {
  it('renders nothing while hidden', () => {
    render(<ModelUpgradeCard upgrade={upgradeStub({ kind: 'hidden' })} isStreaming={false} />);
    expect(screen.queryByTestId('model-upgrade-card')).toBeNull();
  });

  it('offer: names the model, states the honest size, and wires consent', () => {
    const upgrade = upgradeStub({ kind: 'offer', target: TARGET });
    render(<ModelUpgradeCard upgrade={upgrade} isStreaming={false} />);

    expect(screen.getByText('A stronger AI for this device')).toBeTruthy();
    expect(screen.getByText(/1\.4 GB/)).toBeTruthy();
    expect(screen.getByText(/Qwen 3\.5/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /download in background/i }));
    expect(upgrade.accept).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /not now/i }));
    expect(upgrade.decline).toHaveBeenCalledTimes(1);
  });

  it('downloading: shows progress and the keep-chatting reassurance', () => {
    const upgrade = upgradeStub({ kind: 'downloading', target: TARGET, percent: 0.42 });
    render(<ModelUpgradeCard upgrade={upgrade} isStreaming={false} />);

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByText(/keep chatting/i)).toBeTruthy();
  });

  it('ready: swap and later are wired; swap is disabled mid-generation', () => {
    const upgrade = upgradeStub({ kind: 'ready', target: TARGET });
    const { rerender } = render(<ModelUpgradeCard upgrade={upgrade} isStreaming={false} />);

    fireEvent.click(screen.getByRole('button', { name: /switch now/i }));
    expect(upgrade.swapNow).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /later/i }));
    expect(upgrade.notNow).toHaveBeenCalledTimes(1);

    rerender(<ModelUpgradeCard upgrade={upgrade} isStreaming={true} />);
    const swapButton = screen.getByRole('button', { name: /switch now/i }) as HTMLButtonElement;
    expect(swapButton.disabled).toBe(true);
  });

  it('ready: surfaces the honest retry notice when present', () => {
    const upgrade = upgradeStub({
      kind: 'ready',
      target: TARGET,
      notice: "That didn't go smoothly — your current model is untouched. Try again?",
    });
    render(<ModelUpgradeCard upgrade={upgrade} isStreaming={false} />);
    expect(screen.getByText(/untouched/i)).toBeTruthy();
  });

  it('deferred: renders the machine\'s honest message with a quiet dismiss', () => {
    const upgrade = upgradeStub({
      kind: 'deferred',
      deferral: { code: 'insufficient-storage', message: 'Eco needs about 1.5 GB of free space for this model.' },
    });
    render(<ModelUpgradeCard upgrade={upgrade} isStreaming={false} />);

    expect(screen.getByText('Sticking with your current AI')).toBeTruthy();
    expect(screen.getByText(/1\.5 GB of free space/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /okay/i }));
    expect(upgrade.dismiss).toHaveBeenCalledTimes(1);
  });

  it('boosted: shows the boost note and auto-dismisses', () => {
    vi.useFakeTimers();
    const upgrade = upgradeStub({ kind: 'boosted', target: TARGET, atBoot: true });
    render(<ModelUpgradeCard upgrade={upgrade} isStreaming={false} />);

    expect(screen.getByTestId('model-upgrade-boost-note').textContent).toContain('Eco just got a boost');
    expect(screen.getByText(/now running Qwen 3\.5/)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(6_500);
    });
    expect(upgrade.dismiss).toHaveBeenCalledTimes(1);
  });
});
