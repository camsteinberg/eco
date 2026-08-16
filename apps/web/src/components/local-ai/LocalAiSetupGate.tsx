// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { type ReactNode, useEffect } from 'react';
import { useLocalAiSetup } from '../../hooks/local-ai/useLocalAiSetup';
import { useDeviceProfile } from '../../hooks/local-ai/useDeviceProfile';
import { describeDevice, failsMemoryFloor, getDeviceProfile } from '../../local-ai/index';
import type { DeviceProfile } from '../../local-ai/index';
import { isWebKitMobile } from '../../local-ai/device/compatibility';
import type { BelowFloorReasonKind } from './BelowFloorScreen';
import { useChatStore } from '../../stores/chatStore';
import { WelcomeSetup } from './WelcomeSetup';
import { WelcomeCard } from './WelcomeCard';
import { toWelcomeChoices } from './welcome-choices';
import { SetupErrorState } from './SetupErrorState';
import { BelowFloorScreen } from './BelowFloorScreen';

/**
 * Wraps the chat shell. If the user has no model assigned yet, renders
 * the v1.0 welcome / setup pipeline before passing through. If the user
 * already has a ready model, passes through immediately.
 */

export type LocalAiSetupGateProps = {
  children: ReactNode;
  /** Open a diagnostic / support panel from the error state. */
  onTellUsMore?(): void;
};

export function LocalAiSetupGate({
  children,
  onTellUsMore,
}: LocalAiSetupGateProps) {
  const setup = useLocalAiSetup();
  // Reactive: reflects the adapter-probe verdict once it lands during setup. On
  // a WASM/CPU-only device the setup runs a single lighter model on the slower
  // CPU path, so WelcomeSetup sets an honest "lighter model" expectation instead
  // of the standard first-load copy (Every-Device program Phase 0, Finding E).
  const deviceProfile = useDeviceProfile();
  const lightweightDevice = deviceProfile.webgpuSupport === 'wasm-only';

  useEffect(() => {
    // Fire the pipeline on mount. The hook is idempotent.
    void setup.start();
  }, [setup]);

  const setupStatus = setup.status;
  useEffect(() => {
    // The chat store computes selectedModel once at module init. On a fresh
    // profile that happens BEFORE first-run setup, when no slot is ready, so
    // it lands on 'auto'. Recompute when setup reaches ready so the user's
    // first message dispatches on-device instead of hitting the cloud
    // decline. Idempotent for primed profiles (recomputes the same value;
    // explicit persisted choices are respected by the loader).
    if (setupStatus === 'ready') {
      useChatStore.getState().restorePersistedPreferences();
    }
  }, [setupStatus]);

  if (setup.status === 'below-floor') {
    const profile = getDeviceProfile();
    const deviceLabel = describeDevice(profile);
    const reason = deriveBelowFloorReason(profile);
    return (
      <BelowFloorScreen deviceLabel={deviceLabel} reason={reason} />
    );
  }

  if (setup.status === 'error') {
    return (
      <SetupErrorState
        reason={setup.errorReason ?? 'Setup failed'}
        exhausted={setup.errorExhausted}
        triedModelCount={setup.errorTriedModelCount}
        onTryAgain={() => {
          setup.actions.reset();
          void setup.start();
        }}
        onTellUsMore={onTellUsMore ?? (() => undefined)}
      />
    );
  }

  if (setup.status === 'awaiting-choice' && setup.choiceOffer) {
    // First run on a servable device: let the user pick their model before any
    // download. The runner already ran below-floor detection, so we only reach
    // here on a device that can serve at least one model.
    return (
      <WelcomeCard
        choices={toWelcomeChoices(setup.choiceOffer.models)}
        recommendedId={setup.choiceOffer.recommendedId}
        onChoose={(id) => setup.choose(id)}
      />
    );
  }

  if (setup.status === 'initializing' || setup.status === 'setting-up') {
    return (
      <WelcomeSetup
        phase={setup.phase}
        percent={setup.percent}
        etaSeconds={setup.etaSeconds}
        reassuranceIndex={setup.reassuranceIndex}
        priorAttemptFailed={setup.priorAttemptFailed}
        findingFit={setup.findingFit}
        lightweightDevice={lightweightDevice}
        resuming={setup.resuming}
      />
    );
  }

  // status === 'ready' → pass children through.
  return <>{children}</>;
}

/**
 * Which below-floor explanation this device gets. Order matters and is the point:
 *   1. iOS WebKit is gated BEFORE any load (it has WebGPU, but the load itself
 *      crash-loops the tab), so `mobile` must be decided FIRST — otherwise a
 *      capable-looking iOS profile would fall through to the runtime/memory
 *      branches and get the wrong message.
 *   2. No runtime at all → blame the browser (`runtime`).
 *   3. Capable browser but short on memory → blame memory, never the browser.
 *   4. Otherwise an honest "not ready for this setup yet" (`fallback`).
 * Runtime precedes memory because `webgpuSupport === 'none'` subsumes the
 * low-memory genuine-below-floor case.
 */
export function deriveBelowFloorReason(profile: DeviceProfile): BelowFloorReasonKind {
  if (isWebKitMobile(profile)) return 'mobile';
  if (profile.webgpuSupport === 'none') return 'runtime';
  if (failsMemoryFloor(profile)) return 'memory';
  return 'fallback';
}
