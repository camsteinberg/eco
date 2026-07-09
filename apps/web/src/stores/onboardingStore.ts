// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Zustand store for the onboarding wizard.
 *
 * Persists hasCompletedOnboarding to localStorage so the wizard
 * only shows once. SSR-safe: store is only created on the client.
 */

import { createStore, useStore } from 'zustand';
import type { InferenceCapability } from '../lib/inference-capability';
import type { ModelConfig } from '../local-ai/types';
import { getCatalog, getModel } from '../local-ai/catalog/catalog';
import { getSlotForModel, getSlot } from '../local-ai/lifecycle/slots';
import { ONBOARDING_STORAGE_VERSION } from '../lib/onboarding-version';
import { safeStorage, STORAGE_KEYS } from '../lib/local-storage';

export type OnboardingStep = 'seed' | 'sprout' | 'sapling' | 'complete';

export type OnboardingState = {
  step: OnboardingStep;
  hardwareCapability: InferenceCapability | null;
  deviceMemoryGB: number | null;
  recommendedModel: ModelConfig | null;
  downloadProgress: number;
  hasCompletedOnboarding: boolean;
};

export type OnboardingActions = {
  setStep: (step: OnboardingStep) => void;
  setHardware: (cap: InferenceCapability, mem: number | null) => void;
  setRecommendedModel: (model: ModelConfig | null) => void;
  setDownloadProgress: (progress: number) => void;
  completeOnboarding: () => void;
  resetOnboarding: () => void;
};

const initialState: OnboardingState = {
  step: 'seed',
  hardwareCapability: null,
  deviceMemoryGB: null,
  recommendedModel: null,
  downloadProgress: 0,
  hasCompletedOnboarding: false,
};

type PersistedOnboardingState = {
  hasCompletedOnboarding?: boolean;
  step?: OnboardingStep;
  hardwareCapability?: InferenceCapability | null;
  deviceMemoryGB?: number | null;
  recommendedModelId?: string | null;
};

// Hydrate persisted state from localStorage
function loadPersistedState(): Partial<OnboardingState> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = safeStorage.get(STORAGE_KEYS.ONBOARDING);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        state?: PersistedOnboardingState;
        version?: number;
      };
      if (parsed.version !== ONBOARDING_STORAGE_VERSION) {
        return {};
      }

      const persistedState = parsed.state;
      if (!persistedState) {
        return {};
      }

      const launchModelIds = new Set(getCatalog().map((model) => model.id));
      const hydratedRecommendedModel =
        persistedState.recommendedModelId
        && launchModelIds.has(persistedState.recommendedModelId)
        && (() => { const s = getSlotForModel(persistedState.recommendedModelId!); return s !== null && getSlot(s).status === 'ready'; })()
          ? getModel(persistedState.recommendedModelId) ?? null
          : null;
      const hydratedStep =
        persistedState.hasCompletedOnboarding || persistedState.step === 'seed'
          ? persistedState.step ?? initialState.step
          : hydratedRecommendedModel
            ? persistedState.step ?? initialState.step
            : initialState.step;

      return {
        hasCompletedOnboarding: persistedState.hasCompletedOnboarding ?? false,
        step: hydratedStep,
        hardwareCapability: persistedState.hardwareCapability ?? null,
        deviceMemoryGB: persistedState.deviceMemoryGB ?? null,
        recommendedModel: hydratedRecommendedModel,
      };
    }
  } catch {
    // Ignore parse errors
  }
  return {};
}

// Persist minimal state to localStorage
function persistState(state: OnboardingState) {
  if (typeof window === 'undefined') return;
  try {
    const persistedState: PersistedOnboardingState = {
      hasCompletedOnboarding: state.hasCompletedOnboarding,
      step: state.step,
      hardwareCapability: state.hardwareCapability,
      deviceMemoryGB: state.deviceMemoryGB,
      recommendedModelId: state.recommendedModel?.id ?? null,
    };

    safeStorage.set(
      STORAGE_KEYS.ONBOARDING,
      JSON.stringify({
        state: persistedState,
        version: ONBOARDING_STORAGE_VERSION,
      }),
    );
  } catch {
    // Ignore storage errors
  }
}

// Only create the store in browser context (SSR safety)
const store =
  typeof window !== 'undefined'
    ? createStore<OnboardingState & OnboardingActions>()((set, get) => {
        const persisted = loadPersistedState();
        return {
          ...initialState,
          ...persisted,

          setStep: (step) => {
            set({ step });
            persistState({ ...get(), step });
          },

          setHardware: (hardwareCapability, deviceMemoryGB) => {
            set({ hardwareCapability, deviceMemoryGB });
            persistState({ ...get(), hardwareCapability, deviceMemoryGB });
          },

          setRecommendedModel: (recommendedModel) => {
            set({ recommendedModel });
            persistState({ ...get(), recommendedModel });
          },

          setDownloadProgress: (downloadProgress) => {
            set({ downloadProgress });
          },

          completeOnboarding: () => {
            const newState = {
              ...get(),
              hasCompletedOnboarding: true,
              step: 'complete' as OnboardingStep,
            };
            set({
              hasCompletedOnboarding: true,
              step: 'complete',
            });
            persistState(newState);
          },

          resetOnboarding: () => {
            set(initialState);
            persistState(initialState);
          },
        };
      })
    : null;

/**
 * Hook to access the onboarding store.
 * Returns initial state during SSR (hasCompletedOnboarding: false).
 */
export function useOnboardingStore(): OnboardingState & OnboardingActions;
export function useOnboardingStore<T>(
  selector: (state: OnboardingState & OnboardingActions) => T,
): T;
export function useOnboardingStore<T>(
  selector?: (state: OnboardingState & OnboardingActions) => T,
): T | (OnboardingState & OnboardingActions) {
  if (!store) {
    const ssrState: OnboardingState & OnboardingActions = {
      ...initialState,
      setStep: () => {},
      setHardware: () => {},
      setRecommendedModel: () => {},
      setDownloadProgress: () => {},
      completeOnboarding: () => {},
      resetOnboarding: () => {},
    };
    return selector ? selector(ssrState) : ssrState;
  }
  return selector ? useStore(store, selector) : useStore(store);
}

/**
 * Direct access for non-React contexts (e.g., gating OnboardingTour).
 * Returns null during SSR.
 */
export function getOnboardingStore() {
  return store;
}
