// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { WiltedPlantIllustration } from "../illustrations/WiltedPlantIllustration";
import type { LocalModelReadinessAction } from "../../stores/chatStore";
import { useChatStore } from "../../stores/chatStore";
import { isLocalAiSlot } from "../../local-ai/util";
import { getDeviceProfile } from "../../local-ai/device/profile";
import { listCandidates } from "../../local-ai/selection/recommend";
import { getModel } from "../../local-ai/catalog/catalog";
import { getSlot } from "../../local-ai/lifecycle/slots";
import { isModelFullyCached } from "../../local-ai/download/download";
import {
  LOCAL_GENERATION_FALLBACK_MESSAGE,
  LOCAL_GENERATION_REPEATED_MESSAGE,
  LOCAL_RUNTIME_HICCUP_MESSAGE,
} from "../../local-ai/adapters/error-messages";
import { MODEL_PREPARING_BUSY_MESSAGE } from "../../lib/local-heavy-work-owner";
import { CONTEXT_WINDOW_REFUSAL_MESSAGE } from "../../lib/context-window";
import type { Slot } from "../../local-ai/types";

const ERROR_MESSAGES = [
  {
    title: "Something went sideways",
    body: "Even the best-tended gardens have off days. Let\u2019s try that again.",
  },
  {
    title: "The forest is resting",
    body: "Something hit a snag on this device. Give it a moment and try once more.",
  },
  {
    title: "A branch broke",
    body: "That did not work. We are on it; try again shortly.",
  },
];

const CAPACITY_MESSAGE = {
  title: "Something interrupted that response",
  body: "Your turn stays right here in this chat. Try again, or set up a local model to keep going on this device.",
};

const LOCAL_SETUP_MESSAGE_TITLE = "Eco needs one quick setup";
const LOCAL_GENERATION_FAILURE_TITLE = "That reply hit a snag";
const LOCAL_COOLDOWN_MESSAGE_TITLE = "Let this device cool down";
// A model still warming up is not a setup task the user forgot — it's already
// in progress. Say that, so the card doesn't read as "you need to do something."
const MODEL_PREPARING_TITLE = "Your model is still getting ready";
// A context-window refusal isn't a setup problem either — the chat/file is just
// too long for this local model. The honest fix is to shorten, not to "set up."
const CONTEXT_WINDOW_REFUSAL_TITLE = "This conversation is too long";
const BROWSER_UNSUPPORTED_MESSAGE_TITLE = "Eco isn't ready for this browser yet";
const BROWSER_UNSUPPORTED_MESSAGE_BODY =
  "Eco runs its AI right on your device, and this browser can't do that yet. Try Chrome or Edge on a recent device.";
const BROWSER_UNSUPPORTED_MARKER = "browser-local-ai-not-supported";
const MANAGE_MODELS_HREF = "/settings?tab=models";

export type LocalModelPrepareState = {
  status: "idle" | "checking" | "downloading" | "warming" | "ready" | "error";
  progress?: number;
  error?: string | null;
};

/** Simple string hash to deterministically pick an error message. */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

type ErrorMessageProps = {
  onRetry?: () => void;
  message?: string;
  localReadiness?: LocalModelReadinessAction;
  localPrepareState?: LocalModelPrepareState;
  onPrepareLocalModel?: (modelId: string) => void;
};

type CapacityNudge = {
  slot: Slot;
  modelName: string;
};

function detectCapacityNudge(selectedModel: string): CapacityNudge | null {
  if (typeof window === "undefined") return null;
  const slotKey: Slot = isLocalAiSlot(selectedModel) ? selectedModel : "eco-fast";
  const profile = getDeviceProfile();
  try {
    const candidates = listCandidates(slotKey, profile);
    if (candidates.length === 0) return null;
    const topModel = candidates[0]!.model;
    return { slot: slotKey, modelName: topModel.friendlyName };
  } catch {
    return null;
  }
}

type LighterModelNudge = {
  slot: Slot;
  modelName: string;
};

// After a model has faulted twice, offer a genuinely lighter model for this
// device — one strictly smaller than the current pick. Prefer a lighter model
// that's already fully cached (one tap to switch); otherwise offer the
// highest-ranked lighter candidate. Returns null when nothing lighter exists,
// so the caller falls back to the generic Manage Models link.
async function detectLighterModelNudge(
  selectedModel: string,
): Promise<LighterModelNudge | null> {
  if (typeof window === "undefined") return null;
  const slotKey: Slot = isLocalAiSlot(selectedModel) ? selectedModel : "eco-fast";
  const currentModel = isLocalAiSlot(selectedModel)
    ? getSlot(slotKey).model
    : getModel(selectedModel);
  if (!currentModel) return null;
  const profile = getDeviceProfile();
  try {
    const lighter = listCandidates(slotKey, profile)
      .map((candidate) => candidate.model)
      .filter((model) => model.sizeGB < currentModel.sizeGB);
    if (lighter.length === 0) return null;
    let chosen = lighter[0]!;
    for (const model of lighter) {
      if (await isModelFullyCached(model)) {
        chosen = model;
        break;
      }
    }
    return { slot: slotKey, modelName: chosen.friendlyName };
  } catch {
    return null;
  }
}

export function ErrorMessage({
  onRetry,
  message,
  localReadiness,
  localPrepareState,
  onPrepareLocalModel,
}: ErrorMessageProps) {
  const [perking, setPerking] = useState(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const [capacityNudge, setCapacityNudge] = useState<CapacityNudge | null>(null);
  const [lighterNudge, setLighterNudge] = useState<LighterModelNudge | null>(null);

  // Check if this is a capacity-related error
  const isCapacityError =
    message &&
    /miner|contributor|capacity|queue/i.test(message);

  // When a response is interrupted AND the user has a manual-ready local model
  // available for their profile, surface a quiet "set up a local model" link
  // so they have a discoverable path instead of being stranded.
  useEffect(() => {
    if (!isCapacityError) {
      setCapacityNudge(null);
      return;
    }
    setCapacityNudge(detectCapacityNudge(selectedModel));
  }, [isCapacityError, selectedModel]);
  const isBrowserUnsupportedError = Boolean(
    message && message.includes(BROWSER_UNSUPPORTED_MARKER),
  );
  // A recovered on-device generation fault (see useChat's applyLocalGenerationError
  // + chat-recovery). These carry "on-device" wording that would otherwise trip
  // the setup regex below, so classify them first and exempt them from setup.
  const isLocalGenerationFailure =
    message === LOCAL_GENERATION_FALLBACK_MESSAGE
    || message === LOCAL_GENERATION_REPEATED_MESSAGE
    || message === LOCAL_RUNTIME_HICCUP_MESSAGE;
  // A model mid-preparation and a context-window refusal both contain the words
  // "local model", so the setup regex below would otherwise mislabel them as
  // "Eco needs one quick setup". Classify them by exact string first and exempt
  // them from setup — each gets its own honest title.
  const isModelPreparingError = message === MODEL_PREPARING_BUSY_MESSAGE;
  const isContextWindowRefusal = message === CONTEXT_WINDOW_REFUSAL_MESSAGE;
  const isLocalSetupError =
    !isBrowserUnsupportedError
    && !isLocalGenerationFailure
    && !isModelPreparingError
    && !isContextWindowRefusal
    && (Boolean(localReadiness)
      || Boolean(
        message
          && /downloaded|download|preparation|readiness|local model|locally|on-device|Open Models|Manage Models/i.test(message),
      ));
  const isLocalCooldownError = Boolean(
    message
      && /paused this model|graphics device needed a rest|lighter local load|crash-risk|cooling down|needs a short breather/i.test(message),
  );

  // Resolve a lighter-model option only for the repeated-failure card (the copy
  // that promises one). Async because the cached-model check touches storage;
  // mirrors the capacity-nudge effect otherwise.
  useEffect(() => {
    if (message !== LOCAL_GENERATION_REPEATED_MESSAGE) {
      setLighterNudge(null);
      return;
    }
    let cancelled = false;
    void detectLighterModelNudge(selectedModel).then((nudge) => {
      if (!cancelled) setLighterNudge(nudge);
    });
    return () => {
      cancelled = true;
    };
  }, [message, selectedModel]);

  // Pick a stable error message based on hash of the error string
  const errorInfo = isBrowserUnsupportedError
    ? {
        title: BROWSER_UNSUPPORTED_MESSAGE_TITLE,
        body: BROWSER_UNSUPPORTED_MESSAGE_BODY,
      }
    : isLocalCooldownError
    ? {
        title: LOCAL_COOLDOWN_MESSAGE_TITLE,
        body: message,
      }
    : isCapacityError
    ? CAPACITY_MESSAGE
    : isModelPreparingError
    ? {
        title: MODEL_PREPARING_TITLE,
        body: message,
      }
    : isContextWindowRefusal
    ? {
        title: CONTEXT_WINDOW_REFUSAL_TITLE,
        body: message,
      }
    : isLocalGenerationFailure
    ? {
        title: LOCAL_GENERATION_FAILURE_TITLE,
        body: message,
      }
    : isLocalSetupError
    ? {
        title: LOCAL_SETUP_MESSAGE_TITLE,
        body:
          localPrepareState?.status === "ready"
            ? `${localReadiness?.slotLabel ?? "Eco"} is ready. Send your message again when you are ready.`
            : localPrepareState?.status === "error" && localPrepareState.error
              ? localPrepareState.error
              : message,
      }
    : ERROR_MESSAGES[hashString(message ?? "default") % ERROR_MESSAGES.length]!;
  const isPreparing =
    localPrepareState?.status === "checking"
    || localPrepareState?.status === "downloading"
    || localPrepareState?.status === "warming";
  const prepareButtonLabel =
    localPrepareState?.status === "checking"
      ? "Checking..."
      : localPrepareState?.status === "downloading"
        ? `Preparing ${localReadiness?.slotLabel ?? "local AI"}${
            typeof localPrepareState.progress === "number"
              ? ` ${String(Math.round(localPrepareState.progress * 100))}%`
              : ""
          }`
        : localPrepareState?.status === "warming"
          ? `Warming up ${localReadiness?.slotLabel ?? "local AI"}...`
          : localPrepareState?.status === "ready"
            ? "Ready"
            : localReadiness?.status === "downloaded-needs-test"
              ? `Test ${localReadiness.slotLabel}`
              : localReadiness?.status === "partial"
                ? `Resume ${localReadiness.slotLabel}`
            : `Prepare ${localReadiness?.slotLabel ?? "local AI"}`;
  const prepareActionVerb =
    localReadiness?.status === "downloaded-needs-test"
      ? "Test"
      : localReadiness?.status === "partial"
        ? "Resume"
        : "Prepare";

  // Check for reduced motion preference
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const handleRetry = useCallback(() => {
    if (!onRetry) return;

    if (prefersReducedMotion) {
      // Skip animation, call immediately
      onRetry();
      return;
    }

    setPerking(true);
    retryTimerRef.current = setTimeout(() => {
      onRetry();
      setPerking(false);
    }, 500);
  }, [onRetry, prefersReducedMotion]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  return (
    <div role="alert" className="flex flex-col items-center gap-3 py-4">
      <WiltedPlantIllustration perking={perking} />

      <h3
        className="font-serif text-base font-semibold"
        style={{ color: "var(--eco-text)" }}
      >
        {errorInfo.title}
      </h3>

      <p
        className="max-w-xs text-center text-sm"
        style={{ color: "var(--eco-text-secondary)" }}
      >
        {errorInfo.body}
      </p>

      {isLocalGenerationFailure && message === LOCAL_GENERATION_REPEATED_MESSAGE &&
        (lighterNudge ? (
          <a
            data-testid="lighter-model-setup-link"
            href={`/settings?tab=models&setup=${lighterNudge.slot}`}
            className="inline-flex min-h-8 items-center rounded-md text-xs font-medium text-[var(--eco-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]"
          >
            Set up {lighterNudge.modelName} on this device &rarr;
          </a>
        ) : (
          <a
            href={MANAGE_MODELS_HREF}
            className="inline-flex min-h-8 items-center rounded-md text-xs font-medium text-[var(--eco-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]"
          >
            Manage Models
          </a>
        ))}

      {isCapacityError && capacityNudge && (
        <a
          data-testid="capacity-local-setup-link"
          href={`/settings?tab=models&setup=${capacityNudge.slot}`}
          className="inline-flex min-h-8 items-center rounded-md text-xs font-medium text-[var(--eco-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]"
        >
          Set up{" "}
          {capacityNudge.modelName}{" "}
          on this device &rarr;
        </a>
      )}

      {localReadiness && (
        <p
          className="max-w-xs text-center text-xs leading-5"
          style={{ color: "var(--eco-text-secondary)" }}
        >
          This only needs to happen once here. You can manage local modes from Settings.
        </p>
      )}

      {localReadiness && onPrepareLocalModel && (
        <button
          type="button"
          onClick={() => onPrepareLocalModel(localReadiness.modelId)}
          disabled={isPreparing || localPrepareState?.status === "ready"}
          className="mt-1 inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{
            backgroundColor: "var(--eco-primary)",
            opacity: isPreparing || localPrepareState?.status === "ready" ? 0.72 : 1,
          }}
          aria-label={`${prepareActionVerb} ${localReadiness.slotLabel}`}
        >
          {prepareButtonLabel}
        </button>
      )}

      {localReadiness && (
        <a
          href={MANAGE_MODELS_HREF}
          className="inline-flex min-h-8 items-center rounded-md text-xs font-medium text-[var(--eco-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]"
        >
          Manage Models
        </a>
      )}

      {onRetry && !isCapacityError && !isLocalSetupError && !isLocalCooldownError && !isContextWindowRefusal && (
        <button
          type="button"
          onClick={handleRetry}
          className="mt-1 inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: "var(--eco-primary)" }}
          aria-label="Try again"
        >
          Try again
        </button>
      )}
    </div>
  );
}
