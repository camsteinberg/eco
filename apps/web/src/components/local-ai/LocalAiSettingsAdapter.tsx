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
import { setSlot, setSlotStatus } from '../../local-ai/lifecycle/slots';
import { resolveRunningModel } from '../../local-ai/display';
import { isLocalAiSlot } from '../../local-ai/util';
import { isDiagnosticsEnabled } from '../../lib/dev-diagnostics';
import { useChatStore } from '../../stores/chatStore';
import { SettingsEcoTab } from './SettingsEcoTab';
import { SwitchAIDialog } from './SwitchAIDialog';
import type { SwitchAIResult } from '../../hooks/local-ai/useSwitchAI';

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
  const slot = 'eco-fast' as const;
  // The switch flow's reference point (it targets eco-fast): which model a
  // switch replaces / rolls back to.
  const currentModel = state.fastModel ?? state.smartModel;
  // What "Currently running" DISPLAYS is a different question: the model the
  // chat's current selection resolves to, with its own slot's status — so
  // Settings and chat tell one story (a stale eco-fast binding out-named the
  // serving eco-smart model live, 2026-08-05).
  const selectedModel = useChatStore((s) => s.selectedModel);
  const running = resolveRunningModel(selectedModel, state.slots);
  // Status of the switch flow's reference model (above), for the dialog's
  // ready flag.
  const switchReferenceStatus = state.fastModel
    ? state.slots['eco-fast'].status
    : state.smartModel
      ? state.slots['eco-smart'].status
      : null;
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

  const onSwitchRequested = useCallback(
    async (modelId: string): Promise<SwitchAIResult> => {
      const ac = new AbortController();
      abortRef.current = ac;
      setLoadProgress(0);
      setLoadPhase('loading');

      try {
        const result = await prepareModelForSlot({
          slot,
          modelId,
          previous: currentModel,
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
            chatStore.setSelectedModel(slot, { explicit: false });
          }
        }
        return result;
      } finally {
        abortRef.current = null;
        setLoadProgress(0);
        setLoadPhase(null);
      }
    },
    [currentModel],
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
      // Only roll back the slot binding when the removed model was the
      // one currently bound — leaving the other slot untouched.
      if (currentModel?.id === modelId) {
        setSlotStatus(slot, 'empty');
        setSlot(slot, null);
      }
    } catch {
      // Best-effort; the next setup will repair.
    } finally {
      breakdown.refresh();
    }
  }, [breakdown, currentModel]);

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
