// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalModelPrepareState } from "../components/chat/ErrorMessage";
import { useChatStore } from "../stores/chatStore";
import { useConversationStore } from "../stores/conversationStore";
import { isLocalAiModel, isLocalAiSlot } from "../local-ai/util";
import type { Slot } from "../local-ai/types";
import {
  getSlot,
  getSlotForModel,
  subscribe as subscribeSlots,
} from "../local-ai/lifecycle/slots";
import { runSmoke } from "../local-ai/lifecycle/smoke";
import { getActiveModel } from "../local-ai/runtime/lifecycle";
import { computeRestriction, useBatteryAwareness } from "./useBatteryAwareness";
import { ACTIVE_CONVERSATION_STORAGE_KEY } from "../lib/chat-workspace-storage";
import {
  getValidationHarnessState,
  getValidationConversationHistoryFixture,
  getValidationProtectionBanner,
  getValidationSelectedModelBanner,
  type ValidationHarnessState,
} from "../lib/validation-harness";
import {
  acquireLocalHeavyWork,
  describeLocalHeavyWorkBusy,
  getActiveLocalHeavyWorkLease,
} from "../lib/local-heavy-work-owner";
import { executeSetup } from "../local-ai/lifecycle/setup-runner";
import {
  clearValidationConversationHistoryFixture,
  installValidationConversationHistoryFixture,
} from "../lib/validation-conversation-history-fixture";
import { resolveReadyLocalRecoveryModelId } from "../local-ai/lifecycle/recovery";

export type LocalModelReadiness = {
  /** True when the slot the current selection resolves to is ready — the
   *  model the chat will actually dispatch to, not hard-wired eco-fast
   *  (Settings and chat must answer readiness for the same model). */
  localModelReady: boolean;
  /** Whether on-device replies are being kept shorter due to low battery. */
  showBatteryReducedNotice: boolean;
  /** Validation-harness protection banner content, when active. */
  validationProtectionBanner: ReturnType<typeof getValidationProtectionBanner>;
  /** Validation-harness selected-model banner content, when active. */
  validationSelectedModelBanner: ReturnType<typeof getValidationSelectedModelBanner>;
  /** Prepare (warm-up) a local model from a readiness error. */
  handlePrepareLocalModel: (modelId: string) => void;
  /** Resolve the readiness state of a given model id, for the error surface. */
  getLocalPrepareState: (modelId: string) => LocalModelPrepareState;
};

/**
 * Resolve the slot the currently-selected model is bound to, mirroring how
 * `useChat` dispatch resolves a selection into a slot. A slot name resolves to
 * itself; a concrete model id resolves to whichever slot owns it. Warming the
 * same slot the first message will use avoids a wasteful unload+reload in
 * `runtime/lifecycle`.
 *
 * An unowned selection — above all `"auto"`, the fresh-device default — resolves
 * the way dispatch resolves it: the best READY slot, eco-smart first. Falling
 * straight to eco-fast warmed an empty slot on a device whose only binding is
 * eco-smart (a first-run "deeper" pick), so readiness reported not-ready for a
 * model that was ready and the warm-up never touched it.
 */
function resolveSelectedSlot(selectedModel: string): Slot {
  if (isLocalAiSlot(selectedModel)) return selectedModel;
  const owningSlot = getSlotForModel(selectedModel);
  if (owningSlot) return owningSlot;
  for (const slotId of ["eco-smart", "eco-fast"] as const) {
    const candidate = getSlot(slotId);
    if (candidate.status === "ready" && candidate.model) return slotId;
  }
  return "eco-fast";
}

/**
 * Local on-device model readiness: slot subscription, warm-up, battery
 * awareness, the validation harness, and recovery-model resolution. Owns its
 * own state and exposes only what the surface needs.
 */
export function useLocalModelReadiness(): LocalModelReadiness {
  const selectedModel = useChatStore((s) => s.selectedModel);

  // v1: Derive local model readiness from slot state
  const [slotVersion, setSlotVersion] = useState(0);
  useEffect(() => {
    const unsubscribe = subscribeSlots(() => setSlotVersion((v) => v + 1));
    return unsubscribe;
  }, []);

  // The slot the chat's current selection resolves to — readiness answers for
  // the model a send would actually use (hard-wiring eco-fast here made the
  // error card call a ready, serving eco-smart "not ready", 2026-08-05).
  const selectedSlotState = getSlot(resolveSelectedSlot(selectedModel));
  void slotVersion; // force re-derive on slot changes

  const [prepareRunState, setPrepareRunState] = useState<
    { modelId: string; phase: "downloading" | "warming"; progress: number | null } | null
  >(null);
  const [prepareError, setPrepareError] = useState<{ modelId: string; message: string } | null>(null);
  const [downloadedRecoveryModelId, setDownloadedRecoveryModelId] = useState<string | null>(null);

  // The recovery card's REAL driver. Previously this ran a bare smoke (which
  // never flips slot status — dispatch stayed blocked even after a pass) and
  // dead-ended on a 'preparing' slot with an early return, so a slot stuck
  // 'preparing' rendered a permanently disabled "Checking..." button — the
  // ready-state wedge, verified live 2026-08-05. Now every not-ready slot runs
  // the same setup pipeline first-run uses: resume the bound pick (downloading
  // only what's missing), smoke it, and drive the slot to 'ready'/'error'.
  const handlePrepareLocalModel = useCallback(
    (modelId: string) => {
      setPrepareError(null);
      const slot = getSlotForModel(modelId);
      if (!slot) {
        setPrepareError({
          modelId,
          message: "This model is not assigned to an Eco slot. Set it up in Settings.",
        });
        return;
      }
      if (getSlot(slot).status === "ready") {
        // Already ready — nothing to prepare
        return;
      }
      if (prepareRunState) {
        // A prepare driven from this surface is already running.
        return;
      }
      const lease = acquireLocalHeavyWork("readiness");
      if (!lease.ok) {
        setPrepareError({
          modelId,
          message: describeLocalHeavyWorkBusy(lease.active),
        });
        return;
      }
      setPrepareRunState({ modelId, phase: "downloading", progress: null });
      void (async () => {
        try {
          await executeSetup(
            {
              onProgressEvent: (event) => {
                if (event.kind === "progress" && event.phase === "downloading") {
                  setPrepareRunState({ modelId, phase: "downloading", progress: event.percent });
                } else if (event.kind === "progress" && event.phase === "smoke") {
                  setPrepareRunState({ modelId, phase: "warming", progress: null });
                }
              },
              setBelowFloor: () => {
                setPrepareError({
                  modelId,
                  message: "Eco can't run on this device yet.",
                });
              },
              // The slot flip to 'ready' notifies the slot subscription above,
              // which re-derives every consumer — nothing else to do here.
              setReady: () => {},
              setError: (reason) => {
                setPrepareError({ modelId, message: reason });
              },
              markPriorAttemptFailed: () => {},
              markFindingFit: () => {},
              markResuming: () => {},
            },
            { slot },
          );
        } catch (err) {
          setPrepareError({
            modelId,
            message: err instanceof Error
              ? err.message
              : "Eco could not finish setup. Try again from Models.",
          });
        } finally {
          setPrepareRunState(null);
          lease.release();
        }
      })();
    },
    [prepareRunState],
  );

  // ── Mount-time warmup ──────────────────────────────────────────────────
  // When the user already has a downloaded + proven model, load it into the
  // runtime on chat mount so the first message skips the ~2-minute cold
  // weight-load + WebGPU shader compile. This is invisible: gated on slot
  // 'ready' (it NEVER triggers a download — the first-touch setup flow owns
  // that), shares the lifecycle load with the first message (same model id →
  // loadModel no-ops), runs under the same heavy-work lease as a user-driven
  // prepare so it can't collide, and swallows every failure silently. A
  // background warm must never surface a chat error or change visible status.
  //
  // A staged pull no longer suppresses this. Nothing swaps at boot any more —
  // staged weights wait for the user's own "switch now" tap, which may never
  // come — so skipping the warm would leave the model they are ACTUALLY
  // chatting on cold for the whole session.
  const warmedRef = useRef(false);
  useEffect(() => {
    if (warmedRef.current) return;

    const slot = resolveSelectedSlot(useChatStore.getState().selectedModel);
    const slotState = getSlot(slot);
    const warmModel = slotState.model;
    // Only warm a downloaded + smoke-proven model. If it isn't ready, do
    // nothing — the setup flow owns downloading, and warmup must never start
    // a download.
    if (slotState.status !== "ready" || !warmModel) return;

    // Already resident in the runtime (e.g. a remount) — loadModel would
    // no-op, so skip the redundant smoke entirely.
    if (getActiveModel()?.id === warmModel.id) {
      warmedRef.current = true;
      return;
    }

    // Claim the mount-once guard before any await so a fast remount can't
    // double-fire.
    warmedRef.current = true;

    const lease = acquireLocalHeavyWork("readiness");
    if (!lease.ok) {
      // Another local task already holds the runtime (e.g. a user-triggered
      // prepare). Let it warm the model; don't contend.
      return;
    }

    // Mount-only: selectedModel is read imperatively (getState) so a model
    // switch mid-session doesn't re-warm — dispatch handles the switch lazily,
    // and re-warming would fight it. The empty dep array is intentional.
    void (async () => {
      try {
        // probeCache early-exit in runSmoke is the backstop if the cache was
        // cleared between the 'ready' gate and here — it returns
        // { passed: false } without starting a download. We ignore the result
        // entirely: a background warm never surfaces success or failure.
        await runSmoke(slot, warmModel, { timeoutMs: 90_000 });
      } catch {
        // Swallow everything — a background warm is invisible on failure.
      } finally {
        lease.release();
      }
    })();
  }, []);

  // Battery awareness — self-contained, no legacy store writes
  const { level: batteryLevel, charging: batteryCharging } = useBatteryAwareness();

  const [validationHarnessState, setValidationHarnessState] = useState<ValidationHarnessState>({
    enabled: false,
    downloadFailure: "none",
    runtimeMode: "none",
    protectionMode: "none",
    remoteMode: "none",
    heavyWorkDryRun: "none",
  });
  const localRecoveryModelId = selectedSlotState.modelId ?? downloadedRecoveryModelId;
  const localModelReady = localRecoveryModelId !== null && selectedSlotState.status === "ready";
  const batteryRestriction = computeRestriction(batteryLevel, batteryCharging);
  const showBatteryReducedNotice = isLocalAiModel(selectedModel) && batteryRestriction === "reduced";
  const validationProtectionBanner = isLocalAiModel(selectedModel)
    ? getValidationProtectionBanner(validationHarnessState.protectionMode)
    : null;
  const validationSelectedModelBanner = getValidationSelectedModelBanner();

  const getLocalPrepareState = useCallback(
    (modelId: string) => {
      void slotVersion; // re-derive on slot changes
      if (prepareError?.modelId === modelId) {
        return {
          status: "error" as const,
          error: prepareError.message,
        };
      }

      // A prepare run driven from this surface reports its live phase —
      // download progress, then warm-up — regardless of slot status.
      if (prepareRunState?.modelId === modelId) {
        return prepareRunState.phase === "downloading"
          ? {
              status: "downloading" as const,
              ...(prepareRunState.progress !== null
                ? { progress: prepareRunState.progress }
                : {}),
            }
          : { status: "warming" as const };
      }

      const slot = getSlotForModel(modelId);
      if (slot) {
        const state = getSlot(slot);
        if (state.status === "ready") return { status: "ready" as const };
        if (state.status === "preparing") {
          // 'preparing' only means "work is happening" when work IS happening.
          // With no active heavy-work lease, nothing is driving this slot —
          // report idle so the card's button stays actionable ("Resume Eco")
          // instead of a permanently disabled "Checking..." (the ready-state
          // wedge's visible face, verified live 2026-08-05).
          return getActiveLocalHeavyWorkLease() !== null
            ? { status: "checking" as const }
            : { status: "idle" as const };
        }
        if (state.status === "error") {
          return {
            status: "error" as const,
            error: "Setup hit a problem. Try again from Models.",
          };
        }
      }

      return { status: "idle" as const };
    },
    [prepareError, slotVersion, prepareRunState],
  );

  useEffect(() => {
    setValidationHarnessState(getValidationHarnessState());
  }, []);

  useEffect(() => {
    const fixtureMode = getValidationConversationHistoryFixture();
    if (fixtureMode === "none") {
      return;
    }

    let cancelled = false;

    void (async () => {
      if (fixtureMode === "clear") {
        await clearValidationConversationHistoryFixture();
        if (!cancelled) {
          const store = useConversationStore.getState();
          store.removeConversation("eco-validation-conversation-history");
          if (store.activeConversationId === "eco-validation-conversation-history") {
            store.setActive(null);
          }
        }
        return;
      }

      const conversation = await installValidationConversationHistoryFixture(fixtureMode);
      if (cancelled) {
        return;
      }

      useConversationStore.setState((state) => ({
        conversations: [
          conversation,
          ...state.conversations.filter((item) => item.id !== conversation.id),
        ],
        activeConversationId: conversation.id,
      }));
      window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, conversation.id);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedSlotState.status === "ready" && selectedSlotState.modelId) {
      // Slot is ready — no need to search for recovery candidates
      return;
    }

    let cancelled = false;

    void (async () => {
      const modelId = await resolveReadyLocalRecoveryModelId({
        currentModelId: null,
        preferredModelId: selectedModel,
      });

      if (!cancelled) {
        setDownloadedRecoveryModelId(modelId);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedSlotState.status, selectedSlotState.modelId, selectedModel]);

  return {
    localModelReady,
    showBatteryReducedNotice,
    validationProtectionBanner,
    validationSelectedModelBanner,
    handlePrepareLocalModel,
    getLocalPrepareState,
  };
}
