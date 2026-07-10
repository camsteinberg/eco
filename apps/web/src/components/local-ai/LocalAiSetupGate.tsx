// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { type ReactNode, useEffect } from 'react';
import { useLocalAiSetup } from '../../hooks/local-ai/useLocalAiSetup';
import { useDeviceProfile } from '../../hooks/local-ai/useDeviceProfile';
import { describeDevice, getDeviceProfile } from '../../local-ai/index';
import { useChatStore } from '../../stores/chatStore';
import { WelcomeSetup } from './WelcomeSetup';
import { SetupErrorState } from './SetupErrorState';
import { BelowFloorScreen } from './BelowFloorScreen';

/**
 * Wraps the chat shell. If the user has no model assigned yet, renders
 * the v1.0 welcome / setup pipeline before passing through. If the user
 * already has a ready model, passes through immediately.
 */

export type LocalAiSetupGateProps = {
  children: ReactNode;
  /** Optional email signup handler for the below-floor screen. */
  onBelowFloorSignup?(email: string): Promise<void>;
  /** Open a diagnostic / support panel from the error state. */
  onTellUsMore?(): void;
};

export function LocalAiSetupGate({
  children,
  onBelowFloorSignup,
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
    const deviceLabel = describeDevice(getDeviceProfile());
    return (
      <BelowFloorScreen
        deviceLabel={deviceLabel}
        onSignup={onBelowFloorSignup ?? noopSignup}
      />
    );
  }

  if (setup.status === 'error') {
    return (
      <SetupErrorState
        reason={setup.errorReason ?? 'Setup failed'}
        exhausted={setup.errorExhausted}
        onTryAgain={() => {
          setup.actions.reset();
          void setup.start();
        }}
        onTellUsMore={onTellUsMore ?? (() => undefined)}
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

async function noopSignup(_email: string): Promise<void> {
  // Deployment-time default. Real signup is wired in production via
  // mailto: or the marketing/site signup endpoint.
}
