// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useEffect, useState } from 'react';
import { getAllSlots, subscribe, type SlotState } from '../../local-ai/lifecycle/slots';
import type { Slot } from '../../local-ai/types';

/**
 * Reactive view of slot state for the steady-state UI surfaces:
 *   - Chat surface badge ("running on your device")
 *   - Settings → Eco tab
 *
 * Reads from the lifecycle/slots SSoT and re-renders on every change.
 * No I/O of its own.
 */

export type EcoStateView = {
  slots: Record<Slot, SlotState>;
  /** The model in the eco-fast slot, or null if empty. */
  fastModel: SlotState['model'];
  /** The model in the eco-smart slot, or null if empty. */
  smartModel: SlotState['model'];
  /** True when at least one slot has a model in the 'ready' state. */
  hasReadyModel: boolean;
};

export function useEcoState(): EcoStateView {
  const [snapshot, setSnapshot] = useState<Record<Slot, SlotState>>(() => getAllSlots());

  useEffect(() => {
    const unsubscribe = subscribe(() => {
      setSnapshot(getAllSlots());
    });
    // One refresh in case state changed between initial render and subscribe.
    setSnapshot(getAllSlots());
    return () => {
      unsubscribe();
    };
  }, []);

  return {
    slots: snapshot,
    fastModel: snapshot['eco-fast'].model,
    smartModel: snapshot['eco-smart'].model,
    hasReadyModel: Object.values(snapshot).some((s) => s.status === 'ready' && s.model !== null),
  };
}
