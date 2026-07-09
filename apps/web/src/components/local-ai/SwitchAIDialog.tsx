// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Button, Modal, SeedlingIllustration } from '@eco/ui';
import type { ModelConfig } from '../../local-ai/types';
import { getDisplayInfo } from '../../local-ai/display';
import { BotanicalAnimation } from './BotanicalAnimation';
import type {
  FailedConfidence,
  SwitchAIResult,
  SwitchFailureReason,
  UseSwitchAIReturn,
} from '../../hooks/local-ai/useSwitchAI';

type FailureView = {
  failedName: string;
  reason: SwitchFailureReason;
  suggested: ModelConfig | null;
  confidence: FailedConfidence;
  /** Honest copy when the runtime is busy (reason 'busy'). */
  busyMessage?: string;
};

/**
 * Switch your AI dialog.
 *
 * One calm list of every AI Eco can confidently run on this device, ranked
 * by fit. The top entry carries a quiet "Recommended for your device"
 * sublabel — no mode picker, no tier headings, no technical provenance in
 * the primary view. Selecting a row and pressing Save binds that AI.
 *
 * Every entry surfaced has been admitted with benchmark, calculated, or
 * ledger confidence, so there is no "untested — may not work" warning gate.
 * The cascade-on-failure UX still fires if smoke unexpectedly fails — that's
 * the safety net for predictions that turn out wrong.
 *
 * Pure presentational. State + commit live in `useSwitchAI`.
 */

export type SwitchAIDialogProps = {
  open: boolean;
  onClose(): void;
  /** Current model in the slot. */
  currentModel: ModelConfig | null;
  /** State container from useSwitchAI. */
  state: UseSwitchAIReturn;
  /** Load progress fraction (0..1) from the adapter. */
  loadProgress?: number;
  /** Current load phase label (e.g. 'loading', 'load-start', 'load-finish'). */
  loadPhase?: string | null;
  /** Abort the in-flight model load. */
  onAbort?(): void;
};

/**
 * A transient busy — a readiness check or mount warmup holding the runtime
 * for a beat — usually clears within a moment. Rather than hand the user a
 * "Try again" for something that would have worked on its own, we retry once
 * silently after this delay. A second busy means it isn't transient, so we
 * fall back to the manual notice.
 */
const AUTO_RETRY_DELAY_MS = 3_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function SwitchAIDialog({ open, onClose, currentModel, state, loadProgress = 0, loadPhase, onAbort }: SwitchAIDialogProps) {
  const [failure, setFailure] = useState<FailureView | null>(null);
  const [autoRetrying, setAutoRetrying] = useState(false);
  const reduceMotion = useReducedMotion();

  // Each user action (Save, Try suggested, Cancel/close) claims a sequence
  // number; a pending auto-retry only proceeds if it still owns the latest
  // one. This enforces the single-retry cap (no recursion) AND cancels a
  // waiting retry if the user closes the dialog or starts another action —
  // and, via the unmount cleanup, blocks any post-unmount state update.
  const actionSeq = useRef(0);
  useEffect(() => () => { actionSeq.current += 1; }, []);

  const applyResult = (result: SwitchAIResult, intendedName: string): void => {
    if (result.success) {
      setFailure(null);
      onClose();
      return;
    }
    const failedDisplay = result.failedModel
      ? getDisplayInfo(result.failedModel.id, result.failedModel).friendlyName
      : intendedName;
    setFailure({
      failedName: failedDisplay,
      reason: result.reason,
      suggested: result.suggestedNext,
      confidence: result.failedConfidence ?? null,
      ...(result.busyMessage ? { busyMessage: result.busyMessage } : {}),
    });
  };

  /**
   * Run a commit, and on a transient BUSY result retry exactly once after a
   * short wait (showing honest waiting copy meanwhile). Real failures
   * (load-failed, smoke-failed) never auto-retry — they surface immediately.
   */
  const attemptSwitch = async (
    run: () => Promise<SwitchAIResult>,
    intendedName: string,
  ): Promise<void> => {
    const seq = (actionSeq.current += 1);
    setFailure(null);
    setAutoRetrying(false);

    const result = await run();
    if (actionSeq.current !== seq) return;
    if (!result.success && result.reason === 'busy') {
      setAutoRetrying(true);
      await delay(AUTO_RETRY_DELAY_MS);
      if (actionSeq.current !== seq) return;
      setAutoRetrying(false);
      const retried = await run();
      if (actionSeq.current !== seq) return;
      applyResult(retried, intendedName);
      return;
    }
    applyResult(result, intendedName);
  };

  const selectedModel = state.choices.find((c) => c.model.id === state.selectedId)?.model ?? null;

  const handleSave = async (): Promise<void> => {
    const intendedName = selectedModel
      ? getDisplayInfo(selectedModel.id, selectedModel).friendlyName
      : 'this AI';
    await attemptSwitch(() => state.commit(), intendedName);
  };

  const handleTrySuggested = async (suggested: ModelConfig): Promise<void> => {
    const suggestedDisplay = getDisplayInfo(suggested.id, suggested).friendlyName;
    await attemptSwitch(() => state.commitWith(suggested.id), suggestedDisplay);
  };

  const handleClose = (): void => {
    actionSeq.current += 1;
    setAutoRetrying(false);
    setFailure(null);
    onClose();
  };

  const hasChoices = state.choices.length > 0;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next) handleClose(); }}
      title="Switch your AI"
      description="Every AI here runs entirely on your device. Pick the one that fits."
    >
      <div className="flex flex-col gap-4" style={{ fontFamily: 'var(--eco-font-body)', color: 'var(--eco-text)' }}>
        {state.saving && !failure ? (
          <LoadingProgress progress={loadProgress} phase={loadPhase ?? null} />
        ) : hasChoices ? (
          <AiList state={state} currentModelId={currentModel?.id ?? null} />
        ) : (
          <EmptyState />
        )}

        {autoRetrying && <RetryingNotice reduceMotion={reduceMotion} />}

        {failure && !autoRetrying && (failure.reason === 'busy' ? (
          <BusyNotice message={failure.busyMessage} />
        ) : failure.reason === 'network-failed' ? (
          <NetworkNotice failedName={failure.failedName} />
        ) : (
          <FailureNotice
            failure={failure}
            saving={state.saving}
            onTrySuggested={handleTrySuggested}
            onPickAnother={() => setFailure(null)}
          />
        ))}

        <div className="flex flex-row gap-3 justify-end mt-1">
          {state.saving && onAbort ? (
            <Button onClick={onAbort} variant="secondary">
              Stop
            </Button>
          ) : (
            <Button onClick={handleClose} variant="secondary" disabled={state.saving}>
              Cancel
            </Button>
          )}
          <Button
            onClick={handleSave}
            variant="primary"
            disabled={state.saving || autoRetrying || !hasChoices || state.selectedId === null}
          >
            {state.saving || autoRetrying ? 'Switching…' : failure ? 'Try again' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The single calm list. Each AI is a soft selectable row showing its
 * friendly name + one-line quality phrase. The top-ranked entry carries a
 * quiet "Recommended for your device" line. No mono provenance, no radios —
 * the whole row is the control, and a checkmark marks the selection.
 */
function AiList({ state, currentModelId }: { state: UseSwitchAIReturn; currentModelId: string | null }) {
  const reduceMotion = useReducedMotion();
  return (
    <ul role="radiogroup" aria-label="Available AIs" className="flex flex-col gap-2">
      {state.choices.map((choice) => {
        const display = getDisplayInfo(choice.model.id, choice.model);
        const selected = state.selectedId === choice.model.id;
        const isCurrent = currentModelId === choice.model.id;
        return (
          <li key={choice.model.id}>
            <motion.button
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => state.select(choice.model.id)}
              whileTap={reduceMotion ? undefined : { scale: 0.99 }}
              transition={{ type: 'spring', stiffness: 420, damping: 30 }}
              className="flex w-full items-start gap-3 rounded-[var(--eco-radius-md)] px-4 py-3 text-left transition-colors"
              style={{
                background: selected
                  ? 'color-mix(in srgb, var(--eco-primary) 8%, var(--eco-surface))'
                  : 'var(--eco-surface)',
                border: `1px solid ${selected ? 'var(--eco-primary)' : 'var(--eco-border-muted)'}`,
              }}
            >
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                <SelectMark selected={selected} reduceMotion={reduceMotion} />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold" style={{ color: 'var(--eco-text)' }}>
                    {display.friendlyName}
                  </span>
                  {isCurrent && (
                    <span className="text-xs" style={{ color: 'var(--eco-text-muted)' }}>
                      Currently running
                    </span>
                  )}
                </span>
                {display.qualityPhrase && (
                  <span className="text-sm" style={{ color: 'var(--eco-text-secondary)' }}>
                    {display.qualityPhrase}
                  </span>
                )}
                {choice.isTop && (
                  <span
                    className="mt-0.5 inline-flex w-fit items-center gap-1 text-xs font-medium"
                    style={{ color: 'var(--eco-primary)' }}
                  >
                    <Leaf small />
                    Recommended for your device
                  </span>
                )}
              </span>
            </motion.button>
          </li>
        );
      })}
    </ul>
  );
}

function SelectMark({ selected, reduceMotion }: { selected: boolean; reduceMotion: boolean | null }) {
  if (!selected) {
    return (
      <span
        aria-hidden="true"
        className="h-4 w-4 rounded-full"
        style={{ border: '1.5px solid var(--eco-border)' }}
      />
    );
  }
  return (
    <motion.span
      aria-hidden="true"
      initial={reduceMotion ? false : { scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 500, damping: 24 }}
      className="flex h-4 w-4 items-center justify-center rounded-full"
      style={{ background: 'var(--eco-primary)', color: 'var(--eco-on-primary)' }}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </motion.span>
  );
}

function EmptyState() {
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-[var(--eco-radius-md)] p-6 text-center text-sm"
      style={{
        background: 'var(--eco-surface-elevated)',
        border: '1px solid var(--eco-border-muted)',
        color: 'var(--eco-text-secondary)',
      }}
    >
      <span className="text-[var(--eco-primary)] opacity-45" aria-hidden="true">
        <SeedlingIllustration size={56} />
      </span>
      No alternative AIs are available on this device right now.
    </div>
  );
}

function smokeFailedHeadline(name: string, confidence: FailedConfidence): string {
  if (confidence === 'calculated') {
    return `${name} didn't respond as expected. Let's try another AI that's a closer fit for your device.`;
  }
  // benchmark, ledger, or null (legacy): a surprising failure
  return `${name} didn't respond as expected on your device.`;
}

function FailureNotice(props: {
  failure: FailureView;
  saving: boolean;
  onTrySuggested(suggested: ModelConfig): void | Promise<void>;
  onPickAnother(): void;
}) {
  const { failure, saving, onTrySuggested, onPickAnother } = props;
  const headline = failure.reason === 'load-failed'
    ? `We couldn't get ${failure.failedName} running here.`
    : smokeFailedHeadline(failure.failedName, failure.confidence);
  const lead = 'This can happen with certain hardware configurations. We can try the next best fit for your device.';

  return (
    <div
      role="alert"
      className="rounded-[var(--eco-radius-md)] px-4 py-3 text-sm flex flex-col gap-3"
      style={{
        background: 'var(--eco-warning-soft)',
        color: 'var(--eco-text)',
        border: '1px solid var(--eco-warning)',
      }}
    >
      <div className="flex items-start gap-2">
        <Leaf />
        <div className="flex flex-col gap-1">
          <span className="font-medium">{headline}</span>
          <span style={{ color: 'var(--eco-text-secondary)' }}>{lead}</span>
        </div>
      </div>
      <div className="flex flex-row flex-wrap gap-2 ml-7">
        {failure.suggested ? (
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => { void onTrySuggested(failure.suggested as ModelConfig); }}
          >
            {`Try ${getDisplayInfo(failure.suggested.id, failure.suggested).friendlyName}`}
          </Button>
        ) : null}
        <Button variant="secondary" disabled={saving} onClick={onPickAnother}>
          Pick another
        </Button>
      </div>
    </div>
  );
}

/**
 * A dropped connection while downloading — NOT a device problem. We say so
 * plainly and point at the fix (check the connection, try again) rather than
 * offering a downgrade on a false hardware diagnosis. No cascade suggestion:
 * retrying the same model is the honest next step, and the footer's primary
 * button already reads "Try again" while a notice is showing.
 */
function NetworkNotice({ failedName }: { failedName: string }) {
  return (
    <div
      role="alert"
      className="rounded-[var(--eco-radius-md)] px-4 py-3 text-sm flex items-start gap-2"
      style={{
        background: 'var(--eco-warning-soft)',
        color: 'var(--eco-text)',
        border: '1px solid var(--eco-warning)',
      }}
    >
      <Leaf />
      <div className="flex flex-col gap-1">
        <span className="font-medium">{`Your connection dropped while downloading ${failedName}.`}</span>
        <span style={{ color: 'var(--eco-text-secondary)' }}>
          Check your connection, then try again — this is your network, not your device.
        </span>
      </div>
    </div>
  );
}

/**
 * Busy is not a failure: another local model task (a readiness check, an
 * active reply, another switch) holds the runtime right now. Calm neutral
 * surface — no warning color, no cascade suggestion. The footer's primary
 * button already reads "Try again" while a notice is showing.
 */
function BusyNotice({ message }: { message?: string }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-[var(--eco-radius-md)] px-4 py-3 text-sm"
      style={{
        background: 'var(--eco-surface-elevated)',
        color: 'var(--eco-text)',
        border: '1px solid var(--eco-border-muted)',
      }}
    >
      <Leaf />
      <div className="flex flex-col gap-1">
        <span className="font-medium">One moment</span>
        <span style={{ color: 'var(--eco-text-secondary)' }}>
          {message ?? 'Another local model task is running. Try again in a moment.'}
        </span>
      </div>
    </div>
  );
}

/**
 * Auto-retry waiting state: we hit a transient busy and are giving the
 * runtime a beat before trying again silently. Same calm neutral surface as
 * BusyNotice (role=status, elevated, no warning color) — this is not a
 * failure — with a gently breathing leaf so the wait reads as "still working"
 * rather than stalled. Static leaf under reduced motion.
 */
function RetryingNotice({ reduceMotion }: { reduceMotion: boolean | null }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-[var(--eco-radius-md)] px-4 py-3 text-sm"
      style={{
        background: 'var(--eco-surface-elevated)',
        color: 'var(--eco-text)',
        border: '1px solid var(--eco-border-muted)',
      }}
    >
      <motion.span
        aria-hidden="true"
        className="inline-flex"
        style={{ color: 'currentColor' }}
        animate={reduceMotion ? {} : { scale: [1, 1.12, 1], opacity: [0.65, 1, 0.65] }}
        transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
      >
        <Leaf />
      </motion.span>
      <div className="flex flex-col gap-1">
        <span className="font-medium">One moment</span>
        <span style={{ color: 'var(--eco-text-secondary)' }}>
          Finishing a quick check…
        </span>
      </div>
    </div>
  );
}

function loadPhaseLabel(phase: string | null): string {
  switch (phase) {
    case 'downloading':
      return 'Downloading model…';
    case 'load-start':
    case 'loading':
      return 'Loading model weights…';
    case 'load-finish':
      return 'Verifying…';
    case 'runtime-import':
      return 'Preparing runtime…';
    case 'webgpu-probe':
      return 'Checking GPU…';
    default:
      return 'Preparing your AI…';
  }
}

function LoadingProgress({ progress, phase }: { progress: number; phase: string | null }) {
  const pct = Math.round(progress * 100);
  const label = loadPhaseLabel(phase);
  // Map the load fraction to a BotanicalAnimation phase:
  // 0-95% → downloading (seed/sprout), 95-100% → smoke (sapling)
  const botanicalPhase = progress >= 0.95 ? 'smoke' as const : 'downloading' as const;

  return (
    <div
      className="flex flex-col items-center gap-3 py-2"
      role="status"
      aria-label={`Loading: ${pct}%`}
    >
      <BotanicalAnimation phase={botanicalPhase} percent={pct} size={120} />
      <div className="flex flex-col items-center gap-1 w-full max-w-xs">
        <div
          className="w-full h-1.5 rounded-full overflow-hidden"
          style={{ background: 'var(--eco-border-muted)' }}
        >
          <motion.div
            className="h-full rounded-full"
            style={{ background: 'var(--eco-primary)' }}
            animate={{ width: `${Math.max(pct, 2)}%` }}
            transition={{ type: 'spring', stiffness: 120, damping: 26 }}
          />
        </div>
        <span
          className="text-xs"
          style={{ color: 'var(--eco-text-secondary)', fontFamily: 'var(--eco-font-body)' }}
        >
          {label} {pct > 0 ? `${pct}%` : ''}
        </span>
      </div>
    </div>
  );
}

function Leaf({ small = false }: { small?: boolean }) {
  const dim = small ? 12 : 18;
  return (
    <svg
      aria-hidden="true"
      width={dim}
      height={dim}
      viewBox="0 0 24 24"
      fill="none"
      style={{ color: 'currentColor', flex: 'none', marginTop: small ? '0' : '2px' }}
    >
      <path
        d="M4 20c0-8 6-14 16-16-2 10-8 16-16 16zm0 0c0-4 4-8 8-8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
