// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * A storage-reclaim deep link (?tab=models&manage=storage) lands on the Eco tab
 * and scrolls to the "Storage on this device" section, so an "insufficient
 * space" error has somewhere concrete to send people.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { ModelConfig, Slot } from '../../../local-ai/types';
import type { SlotState } from '../../../local-ai/lifecycle/slots';
import { SETTINGS_STORAGE_SECTION_ID } from '../../settings/settingsNavigation';

const FAST_MODEL = { id: 'model/fast', friendlyName: 'Fast' } as unknown as ModelConfig;

const slots: Record<Slot, { model: ModelConfig | null; status: SlotState['status'] }> = {
  'eco-fast': { model: FAST_MODEL, status: 'ready' },
  'eco-smart': { model: null, status: 'empty' },
};

let manageParam = 'storage';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(manageParam ? `manage=${manageParam}` : ''),
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
  getSlotForModel: (modelId: string): Slot | null =>
    slots['eco-fast'].model?.id === modelId ? 'eco-fast' : null,
  setSlot: vi.fn(),
  setSlotStatus: vi.fn(),
}));

vi.mock('../../../hooks/local-ai/useEcoState', () => ({
  useEcoState: () => ({
    fastModel: slots['eco-fast'].model,
    smartModel: slots['eco-smart'].model,
    slots: {
      'eco-fast': { ...slots['eco-fast'], slot: 'eco-fast', modelId: slots['eco-fast'].model?.id ?? null },
      'eco-smart': { ...slots['eco-smart'], slot: 'eco-smart', modelId: null },
    },
  }),
}));

vi.mock('../../../hooks/local-ai/useLocalAiStorageBreakdown', () => ({
  useLocalAiStorageBreakdown: () => ({ status: 'ready', data: null, refresh: vi.fn() }),
}));

vi.mock('../../../hooks/local-ai/useSwitchAI', () => ({
  useSwitchAI: () => ({ recommendation: null, choices: [], selectedId: null, select: vi.fn(), commit: vi.fn(), commitWith: vi.fn(), saving: false }),
}));

vi.mock('../../../local-ai/download/storage', () => ({
  clearModel: vi.fn(async () => {}),
  CacheApiStorage: class {},
}));
vi.mock('../../../local-ai/evidence/ledger', () => ({ clearEvidence: vi.fn() }));
vi.mock('../../../local-ai/runtime/lifecycle', () => ({ generate: vi.fn() }));
vi.mock('../../../local-ai/lifecycle/switch-model', () => ({ prepareModelForSlot: vi.fn(async () => ({ success: true })) }));

vi.mock('../../../stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (s: { selectedModel: string }) => unknown) => selector({ selectedModel: 'auto' }),
    { getState: () => ({ selectedModel: 'auto', setSelectedModel: vi.fn() }) },
  ),
}));

// The real Eco tab renders the anchor the deep link scrolls to; stub it down to
// just that element so this suite is about the scroll wiring, not the tab body.
vi.mock('../SettingsEcoTab', () => ({
  SettingsEcoTab: () => <section id={SETTINGS_STORAGE_SECTION_ID}>storage</section>,
}));
vi.mock('../SwitchAIDialog', () => ({ SwitchAIDialog: () => null }));

import { LocalAiSettingsAdapter } from '../LocalAiSettingsAdapter';

const scrollIntoViewMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  manageParam = 'storage';
  // jsdom does not implement scrollIntoView; install a spy so the guarded call
  // in the adapter runs and can be asserted.
  Element.prototype.scrollIntoView = scrollIntoViewMock;
});

afterEach(() => {
  // @ts-expect-error -- remove the test-only stub
  delete Element.prototype.scrollIntoView;
});

describe('LocalAiSettingsAdapter — storage-reclaim scroll', () => {
  it('scrolls to the storage section when opened with ?manage=storage', async () => {
    render(<LocalAiSettingsAdapter />);
    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalled());
    expect(scrollIntoViewMock).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));
  });

  it('does not scroll on a normal open (no manage param)', async () => {
    manageParam = '';
    render(<LocalAiSettingsAdapter />);
    // Give any deferred frame a chance to fire, then assert it stayed put.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });
});
