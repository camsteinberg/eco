// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEcoState } from '../../hooks/local-ai/useEcoState';
import { useSwitchAI } from '../../hooks/local-ai/useSwitchAI';
import { useLocalAiStorageBreakdown } from '../../hooks/local-ai/useLocalAiStorageBreakdown';
import { clearModel } from '../../local-ai/download/storage';
import { CacheApiStorage } from '../../local-ai/download/storage';
import { clearEvidence } from '../../local-ai/evidence/ledger';
import { generate as generateThroughLifecycle } from '../../local-ai/runtime/lifecycle';
import { prepareModelForSlot } from '../../local-ai/lifecycle/switch-model';
import { getSlot, getSlotForModel, setSlot, setSlotStatus } from '../../local-ai/lifecycle/slots';
import { resolveRunningModel } from '../../local-ai/display';
import { isLocalAiSlot } from '../../local-ai/util';
import { isDiagnosticsEnabled } from '../../lib/dev-diagnostics';
import { useChatStore } from '../../stores/chatStore';
import { SettingsEcoTab } from './SettingsEcoTab';
import { SwitchAIDialog } from './SwitchAIDialog';
import type { SwitchAIResult } from '../../hooks/local-ai/useSwitchAI';
import type { Slot } from '../../local-ai/types';

/**
 * Adapter that connects the pure SettingsEcoTab + SwitchAIDialog
 * components to live local-ai/ state. Mounted unconditionally by the
 * Settings → Models tab.
 *
 * The switch flow itself (download → load → smoke → bind, with rollback,
 * stall watchdog, and lease guarding) lives in the React-free
 * `lifecycle/switch-model` primitive — this adapter only maps its
 * progress events into dialog state and keeps the chat store's slot
 * binding in sync after a successful switch.
 */

export function LocalAiSettingsAdapter() {
  const state = useEcoState();
  // The switch flow's reference point: which model a switch replaces / rolls
  // back to.
  const currentModel = state.fastModel ?? state.smartModel;
  // The slot that OWNS that model. Hardcoding eco-fast here made Settings edit
  // a slot the model wasn't in whenever the device's only binding was eco-smart
  // (a first-run "deeper" pick), so a switch wrote a second copy into eco-fast
  // and a removal left the real binding dangling.
  const slot: Slot = currentModel ? getSlotForModel(currentModel.id) ?? 'eco-fast' : 'eco-fast';
  // What "Currently running" DISPLAYS is a different question: the model the
  // chat's current selection resolves to, with its own slot's status — so
  // Settings and chat tell one story (a stale eco-fast binding out-named the
  // serving eco-smart model live, 2026-08-05).
  const selectedModel = useChatStore((s) => s.selectedModel);
  const running = resolveRunningModel(selectedModel, state.slots);
  // Status of the switch flow's reference model (above), for the dialog's
  // ready flag — read from the slot that actually owns it.
  const switchReferenceStatus = currentModel ? state.slots[slot].status : null;
  const router = useRouter();
  const searchParams = useSearchParams();

  // Show the diagnostics link when the sticky dev flag (or ?eco-diagnostics=1
  // in the current URL) is set, or when document.referrer contained the param
  // (coming back from the diag page). The sticky flag matters: this link is
  // the only receipt-preserving route to the diagnostics export (receipts are
  // in-memory only), and in-app navigation drops URL params.
  const showDiagnosticsLink = useMemo(() => {
    if (isDiagnosticsEnabled(`?${searchParams.toString()}`)) return true;
    if (typeof document !== 'undefined' && document.referrer) {
      try {
        const ref = new URL(document.referrer);
        return ref.searchParams.get('eco-diagnostics') === '1';
      } catch {
        return false;
      }
    }
    return false;
  }, [searchParams]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [loadProgress, setLoadProgress] = useState<number>(0);
  const [loadPhase, setLoadPhase] = useState<string | null>(null);

  // Abort controller for the in-flight switch. The ref persists across
  // renders so the dialog's Cancel button can signal the same controller
  // the primitive's watchdog shares.
  const abortRef = useRef<AbortController | null>(null);

  // Per-model storage breakdown (v7.1) — iterates the catalog and asks
  // the Cache API for each model's actual cached bytes. Refreshes
  // automatically when slots change (a fresh download bumps state.slots).
  const breakdown = useLocalAiStorageBreakdown({ refreshKey: state.slots });

  // What the storage panel groups by: which model each slot holds right now.
  // Read from the same live slot snapshot the rest of this adapter uses, so a
  // download or a removal regroups the cards without a reload.
  const slotModelIds: Record<Slot, string | null> = useMemo(
    () => ({
      'eco-fast': state.slots['eco-fast'].modelId,
      'eco-smart': state.slots['eco-smart'].modelId,
    }),
    [state.slots],
  );

  const onSwitchRequested = useCallback(
    async (modelId: string): Promise<SwitchAIResult> => {
      const ac = new AbortController();
      abortRef.current = ac;
      setLoadProgress(0);
      setLoadPhase('loading');
      // A model the OTHER slot already owns switches in place, in that slot —
      // binding it here as well would leave the same model in both slots.
      const targetSlot: Slot = getSlotForModel(modelId) ?? slot;

      try {
        const result = await prepareModelForSlot({
          slot: targetSlot,
          modelId,
          previous: getSlot(targetSlot).model,
          signal: ac.signal,
          onProgress: (event) => {
            if (event.kind === 'phase') {
              setLoadPhase(event.phase);
              // The bar restarts per phase (download fills, then load fills)
              // with the label naming the phase — honest, installer-style.
              setLoadProgress(0);
            } else {
              setLoadProgress(event.fraction);
            }
          },
        });

        if (result.success) {
          // Defensive: if the chat store is holding a concrete model id that
          // no slot owns after this rebind, useChat.ts reverse-lookup
          // collapses to the hardcoded 'eco-fast' fallback. Sync the store
          // to the slot name so resolution stays slot-stable across switches.
          const chatStore = useChatStore.getState();
          if (!isLocalAiSlot(chatStore.selectedModel)) {
            chatStore.setSelectedModel(targetSlot, { explicit: false });
          }
        }
        return result;
      } finally {
        abortRef.current = null;
        setLoadProgress(0);
        setLoadPhase(null);
      }
    },
    [slot],
  );

  const handleAbort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const switchState = useSwitchAI({
    slot,
    currentModel,
    onSwitchRequested,
  });

  const onClearCache = useCallback(async (modelId: string) => {
    try {
      await clearModel(new CacheApiStorage(), modelId);
      // Drop the model's evidence so a fresh install starts with a clean
      // slate — repeated install/uninstall cycles shouldn't accumulate
      // stale smoke-fail entries that bias the recommendation engine.
      clearEvidence(modelId);
      // Roll back the binding of whichever slot owned the removed model, and
      // only that slot. The old check compared against the eco-fast reference
      // model alone, so removing an eco-smart-bound model deleted its bytes and
      // left the slot still pointing at them — a binding with nothing behind it.
      const owningSlot = getSlotForModel(modelId);
      if (owningSlot) {
        setSlotStatus(owningSlot, 'empty');
        setSlot(owningSlot, null);
      }
    } catch {
      // Best-effort; the next setup will repair.
    } finally {
      breakdown.refresh();
    }
  }, [breakdown]);

  // Reference unused import to keep lint happy until SettingsEcoTab
  // consumes generate directly.
  void generateThroughLifecycle;

  return (
    <>
      <SettingsEcoTab
        currentModel={running.model}
        currentModelStatus={running.status ?? undefined}
        storageBreakdown={breakdown.data}
        storageStatus={breakdown.status}
        slotModelIds={slotModelIds}
        onSwitchAI={() => setDialogOpen(true)}
        onShowDiagnostic={showDiagnosticsLink ? () => router.push('/diagnostics/local-ai?eco-diagnostics=1') : undefined}
        onClearCache={onClearCache}
      />
      <SwitchAIDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        currentModel={currentModel}
        currentModelReady={switchReferenceStatus === 'ready'}
        state={switchState}
        loadProgress={loadProgress}
        loadPhase={loadPhase}
        onAbort={handleAbort}
      />
    </>
  );
}
