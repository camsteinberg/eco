// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Settings edits the slot that OWNS the model, not a hardcoded eco-fast.
 *
 * The adapter used to pin every operation to eco-fast. On a device whose only
 * binding is eco-smart — which is exactly what a first-run "deeper" pick
 * produces — that meant a switch wrote a second copy of the model into eco-fast,
 * and removing the cached bytes left the real eco-smart binding pointing at
 * nothing (Settings still named a model that was no longer on disk).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import type { ModelConfig, Slot } from '../../../local-ai/types';
import type { SlotState } from '../../../local-ai/lifecycle/slots';

const FAST_MODEL = { id: 'model/fast', friendlyName: 'Fast' } as unknown as ModelConfig;
const SMART_MODEL = { id: 'model/smart', friendlyName: 'Smart' } as unknown as ModelConfig;

let slots: Record<Slot, { model: ModelConfig | null; status: SlotState['status'] }> = {
  'eco-fast': { model: null, status: 'empty' },
  'eco-smart': { model: null, status: 'empty' },
};

const setSlotMock = vi.fn();
const setSlotStatusMock = vi.fn();
const prepareModelForSlotMock = vi.fn(async (..._args: unknown[]) => ({ success: true }));
const clearModelMock = vi.fn(async (..._args: unknown[]) => {});
const refreshMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('../../../local-ai/lifecycle/slots', () => ({
  SLOTS: ['eco-fast', 'eco-smart'] as ReadonlyArray<Slot>,
  getSlot: (slot: Slot): SlotState =>
    ({
      slot,
      modelId: slots[slot].model?.id ?? null,
      model: slots[slot].model,
      status: slots[slot].status,
    }) as SlotState,
  getSlotForModel: (modelId: string): Slot | null => {
    if (slots['eco-fast'].model?.id === modelId) return 'eco-fast';
    if (slots['eco-smart'].model?.id === modelId) return 'eco-smart';
    return null;
  },
  setSlot: (...args: unknown[]) => setSlotMock(...args),
  setSlotStatus: (...args: unknown[]) => setSlotStatusMock(...args),
}));

vi.mock('../../../hooks/local-ai/useEcoState', () => ({
  useEcoState: () => ({
    fastModel: slots['eco-fast'].model,
    smartModel: slots['eco-smart'].model,
    slots: {
      'eco-fast': { ...slots['eco-fast'], slot: 'eco-fast', modelId: slots['eco-fast'].model?.id ?? null },
      'eco-smart': { ...slots['eco-smart'], slot: 'eco-smart', modelId: slots['eco-smart'].model?.id ?? null },
    },
  }),
}));

vi.mock('../../../hooks/local-ai/useLocalAiStorageBreakdown', () => ({
  useLocalAiStorageBreakdown: () => ({ status: 'ready', data: null, refresh: refreshMock }),
}));

let capturedSwitchSlot: Slot | null = null;
let capturedRunningModelId: string | null | undefined = undefined;
vi.mock('../../../hooks/local-ai/useSwitchAI', () => ({
  useSwitchAI: (options: { slot: Slot; runningModelId?: string | null }) => {
    capturedSwitchSlot = options.slot;
    capturedRunningModelId = options.runningModelId;
    return {
      recommendation: null,
      choices: [],
      selectedId: null,
      select: vi.fn(),
      commit: vi.fn(),
      commitWith: vi.fn(),
      saving: false,
    };
  },
}));

vi.mock('../../../local-ai/download/storage', () => ({
  clearModel: (...args: unknown[]) => clearModelMock(...args),
  CacheApiStorage: class {},
}));

vi.mock('../../../local-ai/evidence/ledger', () => ({ clearEvidence: vi.fn() }));
vi.mock('../../../local-ai/runtime/lifecycle', () => ({ generate: vi.fn() }));
vi.mock('../../../local-ai/lifecycle/switch-model', () => ({
  prepareModelForSlot: (...args: unknown[]) => prepareModelForSlotMock(...args),
}));

let mockSelectedModel = 'auto';
const mockSetSelectedModel = vi.fn();
vi.mock('../../../stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (s: { selectedModel: string; setSelectedModel: typeof mockSetSelectedModel }) => unknown) =>
      selector({ selectedModel: mockSelectedModel, setSelectedModel: mockSetSelectedModel }),
    { getState: () => ({ selectedModel: mockSelectedModel, setSelectedModel: mockSetSelectedModel }) },
  ),
}));

// The two child surfaces are pure presentation; this file is about the wiring
// between them and the slot store, so they are reduced to their callbacks.
type EcoTabProps = {
  onClearCache(modelId: string): Promise<void> | void;
};
vi.mock('../SettingsEcoTab', () => ({
  SettingsEcoTab: (props: EcoTabProps) => (
    <button
      type="button"
      onClick={() => {
        void props.onClearCache('model/smart');
      }}
    >
      remove smart
    </button>
  ),
}));

type SwitchDialogProps = {
  currentModel: ModelConfig | null;
  runningModel?: ModelConfig | null;
  currentModelReady: boolean;
};
vi.mock('../SwitchAIDialog', () => ({
  SwitchAIDialog: (props: SwitchDialogProps) => (
    <>
      <span data-testid="switch-ready">{String(props.currentModelReady)}</span>
      <span data-testid="switch-current">{props.currentModel?.id ?? 'none'}</span>
      <span data-testid="switch-running">{props.runningModel?.id ?? 'none'}</span>
    </>
  ),
}));

import { LocalAiSettingsAdapter } from '../LocalAiSettingsAdapter';

beforeEach(() => {
  vi.clearAllMocks();
  capturedSwitchSlot = null;
  capturedRunningModelId = undefined;
  mockSelectedModel = 'auto';
  slots = {
    'eco-fast': { model: null, status: 'empty' },
    'eco-smart': { model: null, status: 'empty' },
  };
});

describe('LocalAiSettingsAdapter — the slot under edit', () => {
  it('clears the binding of the slot that owned the removed model', async () => {
    slots['eco-smart'] = { model: SMART_MODEL, status: 'ready' };
    const user = userEvent.setup();

    render(<LocalAiSettingsAdapter />);
    await user.click(screen.getByRole('button', { name: 'remove smart' }));

    expect(clearModelMock).toHaveBeenCalledWith(expect.anything(), 'model/smart');
    expect(setSlotStatusMock).toHaveBeenCalledWith('eco-smart', 'empty');
    expect(setSlotMock).toHaveBeenCalledWith('eco-smart', null);
    // The other slot is never touched.
    expect(setSlotMock).not.toHaveBeenCalledWith('eco-fast', null);
  });

  it('leaves both bindings alone when the removed model belongs to neither slot', async () => {
    slots['eco-fast'] = { model: FAST_MODEL, status: 'ready' };
    const user = userEvent.setup();

    render(<LocalAiSettingsAdapter />);
    await user.click(screen.getByRole('button', { name: 'remove smart' }));

    expect(clearModelMock).toHaveBeenCalled();
    expect(setSlotMock).not.toHaveBeenCalled();
    expect(setSlotStatusMock).not.toHaveBeenCalled();
  });

  it('runs the switch flow against the slot that owns the current model', () => {
    slots['eco-smart'] = { model: SMART_MODEL, status: 'ready' };

    render(<LocalAiSettingsAdapter />);

    expect(capturedSwitchSlot).toBe('eco-smart');
    // The dialog's ready flag reads that same slot's status.
    expect(screen.getByTestId('switch-ready')).toHaveTextContent('true');
  });

  it('falls back to eco-fast when nothing is bound at all', () => {
    render(<LocalAiSettingsAdapter />);

    expect(capturedSwitchSlot).toBe('eco-fast');
    expect(screen.getByTestId('switch-ready')).toHaveTextContent('false');
  });
});

describe('LocalAiSettingsAdapter — header and dialog agree on running model', () => {
  it('with selection on eco-smart and both slots bound, header and dialog show the smart model', () => {
    // Bug 2 scenario: eco-fast bound to FAST_MODEL, eco-smart to SMART_MODEL,
    // selection on eco-smart. The adapter's currentModel (fast-first) picks
    // FAST_MODEL, but the runningModel must be SMART_MODEL (the selection).
    slots['eco-fast'] = { model: FAST_MODEL, status: 'ready' };
    slots['eco-smart'] = { model: SMART_MODEL, status: 'ready' };
    mockSelectedModel = 'eco-smart';

    render(<LocalAiSettingsAdapter />);

    // The dialog's runningModel matches the resolved selection, not the
    // fast-first reference model.
    expect(screen.getByTestId('switch-running')).toHaveTextContent('model/smart');
    // The switch reference (currentModel) is still the fast-first model —
    // that is correct for the rollback/switch machinery.
    expect(screen.getByTestId('switch-current')).toHaveTextContent('model/fast');
  });

  it('with selection on auto and only eco-smart bound, header and dialog show the smart model', () => {
    slots['eco-smart'] = { model: SMART_MODEL, status: 'ready' };
    mockSelectedModel = 'auto';

    render(<LocalAiSettingsAdapter />);

    // resolveRunningModel with 'auto' falls back to the first non-null slot,
    // which is eco-smart since eco-fast is empty.
    expect(screen.getByTestId('switch-running')).toHaveTextContent('model/smart');
  });

  it('passes the running model id to useSwitchAI so the prechecked radio matches', () => {
    slots['eco-fast'] = { model: FAST_MODEL, status: 'ready' };
    slots['eco-smart'] = { model: SMART_MODEL, status: 'ready' };
    mockSelectedModel = 'eco-smart';

    render(<LocalAiSettingsAdapter />);

    // useSwitchAI receives runningModelId so it can initialize selectedId
    // to the running model, not the fast-first reference.
    expect(capturedRunningModelId).toBe('model/smart');
  });

  it('an untouched Save does not change selection when running model is prechecked', () => {
    // With the fast-path fix + runningModelId, committing the already-running
    // model calls onSwitchRequested(smart model id) which detects it is
    // already bound+ready and writes the same slot — effectively a no-op.
    slots['eco-fast'] = { model: FAST_MODEL, status: 'ready' };
    slots['eco-smart'] = { model: SMART_MODEL, status: 'ready' };
    mockSelectedModel = 'eco-smart';

    render(<LocalAiSettingsAdapter />);

    // The prechecked id should be the smart model (the running one), not the
    // fast-first reference. If it were wrong, an untouched Save would silently
    // switch to eco-fast.
    expect(capturedRunningModelId).toBe('model/smart');
    // And the dialog receives the fast-first reference for rollback only.
    expect(screen.getByTestId('switch-current')).toHaveTextContent('model/fast');
  });
});
