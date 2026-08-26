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
import { isModelDownloaded } from "../../local-ai/download/download";
import {
  LOCAL_GENERATION_FALLBACK_MESSAGE,
  LOCAL_GENERATION_REPEATED_MESSAGE,
  LOCAL_RUNTIME_HICCUP_MESSAGE,
  DEVICE_PROTECTION_MESSAGE,
  LOCAL_MODEL_OTHER_TAB_MESSAGE,
  TEMPLATE_MISSING_USER_MESSAGE,
} from "../../local-ai/adapters/error-messages";
import { getDisplayInfo } from "../../local-ai/display";
import { MODEL_PREPARING_BUSY_MESSAGE } from "../../lib/local-heavy-work-owner";
import { CONTEXT_WINDOW_REFUSAL_MESSAGE } from "../../lib/context-window";
import { looksLikeStorageShortage } from "../../local-ai/adapters/storage-shortage";
import { MANAGE_STORAGE_HREF } from "../settings/settingsNavigation";
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
    // No-excuse-UI: everything runs on the user's own device — never promise
    // that somebody unseen is fixing it ("We are on it" was a false promise).
    title: "A branch broke",
    body: "That did not work on this device. Give it another try.",
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
const DEVICE_PROTECTION_TITLE = "Paused to protect your device";
// The on-device model is already running in another tab. Not a setup task and
// not a fault — the honest fix is to switch to that tab or close it, so this
// card gets its own calm title and keeps Try again (a retry succeeds once the
// other tab releases the GPU).
const OTHER_TAB_TITLE = "Eco is open in another tab";
// A broken chat template is a damaged copy of the model, not a setup step the
// user skipped — and retrying reads the same broken file, so this card offers
// the one thing that can work: getting a fresh copy.
const TEMPLATE_MISSING_TITLE = "This model needs a fresh copy";
/**
 * Card body for the template-missing card.
 *
 * The marker string itself (`TEMPLATE_MISSING_USER_MESSAGE`) stays byte-stable
 * — it is what already-saved conversations carry, and what this card matches on
 * — so the body it renders lives here instead. Its prose "Open Settings → Eco
 * to re-download it" is dropped because the card now carries a real link.
 */
const TEMPLATE_MISSING_BODY =
  "Eco can't read this model's chat format. Re-downloading it usually fixes this.";
// The blocker is this device, not necessarily its browser: Eco ships an
// iPhone/iPad lane and serves Android Chromium, so a browser-shaped headline
// would be false for both. The body carries the specific reason.
const BROWSER_UNSUPPORTED_MESSAGE_TITLE = "Eco can't run on this device yet";
/**
 * Fallback body only. The marker normally carries device-specific guidance from
 * `local-ai/device/diagnosis.ts` — the honest, profile-aware explanation — and
 * that is what gets rendered. This generic line is for a marker with no
 * guidance attached, so it must stay true for every device that can reach it.
 */
const BROWSER_UNSUPPORTED_MESSAGE_BODY =
  "Eco runs its AI right on your device, and this device can't do that yet.";
const BROWSER_UNSUPPORTED_MARKER = "browser-local-ai-not-supported";

/** The guidance the diagnosis attached to the marker, if any. */
function browserUnsupportedBody(message: string | undefined): string {
  const guidance = message?.split(`${BROWSER_UNSUPPORTED_MARKER}:`)[1]?.trim();
  if (!guidance) return BROWSER_UNSUPPORTED_MESSAGE_BODY;
  return guidance;
}
const MANAGE_MODELS_HREF = "/settings?tab=models";

/**
 * The "Set up <model> on this device" nudge label, as ONE text run.
 *
 * Both nudge links are `inline-flex`. A flex container wraps its child text in
 * anonymous flex items and is free to drop the whitespace that separates them,
 * so a label assembled from several JSX text runs rendered as
 * "Set up LFM2.5on this device". Interpolating the model name into a single
 * string keeps the spacing inside the run, where it is just text — do not split
 * this back into sibling nodes.
 */
function setUpOnThisDeviceLabel(modelName: string): string {
  return `Set up ${modelName} on this device →`;
}

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
    // Branded display name, same as every choice surface — the raw catalog
    // name ("LFM2.5 1.2B") must not leak into the error path.
    return { slot: slotKey, modelName: getDisplayInfo(topModel.id, topModel).friendlyName };
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
      // Runtime-aware: a downloaded `webllm` candidate lives in WebLLM's cache
      // (its Eco staging copy is emptied after bridging), so a bare Eco-cache
      // probe would misread it as not-cached and offer a download instead of
      // the one-tap switch to already-present weights.
      if (await isModelDownloaded(model)) {
        chosen = model;
        break;
      }
    }
    return { slot: slotKey, modelName: getDisplayInfo(chosen.id, chosen).friendlyName };
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
  // A low battery paused on-device work. The copy says "on-device" and "locally",
  // so the setup regex below would label a flat battery "Eco needs one quick
  // setup" — and, because that title also suppresses Try again, leave the card
  // with no action at all. Classify it by exact string and exempt it.
  const isDeviceProtectionPause = message === DEVICE_PROTECTION_MESSAGE;
  // The model is running in another tab. The copy says "on-device", so the
  // setup regex below would mislabel it "Eco needs one quick setup" (and
  // suppress Try again, leaving no action). Classify it by exact string and
  // exempt it — it keeps its own title and the Try again the retry relies on.
  const isOtherTabBusy = message === LOCAL_MODEL_OTHER_TAB_MESSAGE;
  // Same trap, worst case: the copy says "re-download it", so the setup regex
  // relabelled a damaged model file as "Eco needs one quick setup" — a title
  // that also suppresses Try again, leaving the card with no action while its
  // own body told the user to go to Settings. Classify it by exact string.
  const isTemplateMissingError = message === TEMPLATE_MISSING_USER_MESSAGE;
  const isLocalSetupError =
    !isBrowserUnsupportedError
    && !isLocalGenerationFailure
    && !isModelPreparingError
    && !isContextWindowRefusal
    && !isDeviceProtectionPause
    && !isOtherTabBusy
    && !isTemplateMissingError
    && (Boolean(localReadiness)
      || Boolean(
        message
          && /downloaded|download|preparation|readiness|local model|locally|on-device|Open Models|Manage Models/i.test(message),
      ));
  const isLocalCooldownError = Boolean(
    message
      && /paused this model|graphics device needed a rest|crash-risk|cooling down|needs a short breather/i.test(message),
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
        body: browserUnsupportedBody(message),
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
    : isDeviceProtectionPause
    ? {
        title: DEVICE_PROTECTION_TITLE,
        body: message,
      }
    : isOtherTabBusy
    ? {
        title: OTHER_TAB_TITLE,
        body: message,
      }
    : isTemplateMissingError
    ? {
        title: TEMPLATE_MISSING_TITLE,
        body: TEMPLATE_MISSING_BODY,
      }
    : isLocalGenerationFailure
    ? {
        title: LOCAL_GENERATION_FAILURE_TITLE,
        body: message,
      }
    : isLocalSetupError
    ? {
        // Once the model IS ready the card must stop claiming setup is needed
        // — the old copy said both in one breath (verified live 2026-08-05).
        // The retry itself is automatic (useChat's invisible readiness retry),
        // so the body reports that, not an instruction to resend.
        title:
          localPrepareState?.status === "ready"
            ? `${localReadiness?.slotLabel ?? "Eco"} is ready`
            : LOCAL_SETUP_MESSAGE_TITLE,
        body:
          localPrepareState?.status === "ready"
            ? "Finishing up — your message will send itself in a moment."
            : localPrepareState?.status === "error" && localPrepareState.error
              ? localPrepareState.error
              : message,
      }
    : ERROR_MESSAGES[hashString(message ?? "default") % ERROR_MESSAGES.length]!;
  /**
   * Offer Try again only where an unchanged retry could actually succeed.
   *
   * Every case excluded here would fail the same way a second time, or fail on
   * a thing the button cannot change: a busy model has to finish preparing, a
   * device that lacks the graphics support will still lack it, and a damaged
   * chat template is read again exactly as-is. Those cards carry their own
   * honest action (or, for a wait, none) instead.
   */
  const retryCanHelp =
    !isCapacityError
    && !isLocalSetupError
    && !isLocalCooldownError
    && !isContextWindowRefusal
    && !isModelPreparingError
    && !isBrowserUnsupportedError
    && !isTemplateMissingError;

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

  // A prepare launched from this card can exhaust on disk space; when it does,
  // an identical retry is doomed and "Manage Models" is too vague. Point the
  // readiness link at the storage-reclaim panel instead, so removing an unused
  // model is one tap away. Keyed off the (verbatim) storage-shortage message.
  const isStoragePrepareFailure =
    localPrepareState?.status === "error" &&
    looksLikeStorageShortage(localPrepareState.error ?? "");

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
            {setUpOnThisDeviceLabel(lighterNudge.modelName)}
          </a>
        ) : (
          <a
            href={MANAGE_MODELS_HREF}
            className="inline-flex min-h-8 items-center rounded-md text-xs font-medium text-[var(--eco-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]"
          >
            Manage Models
          </a>
        ))}

      {isTemplateMissingError && (
        <a
          data-testid="template-missing-models-link"
          href={MANAGE_MODELS_HREF}
          className="inline-flex min-h-8 items-center rounded-md text-xs font-medium text-[var(--eco-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]"
        >
          Manage Models
        </a>
      )}

      {isCapacityError && capacityNudge && (
        <a
          data-testid="capacity-local-setup-link"
          href={`/settings?tab=models&setup=${capacityNudge.slot}`}
          className="inline-flex min-h-8 items-center rounded-md text-xs font-medium text-[var(--eco-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]"
        >
          {setUpOnThisDeviceLabel(capacityNudge.modelName)}
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
          className="mt-1 inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2 text-sm font-medium text-[var(--eco-on-primary)] transition-opacity hover:opacity-90"
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
          data-testid={isStoragePrepareFailure ? "storage-reclaim-link" : undefined}
          href={isStoragePrepareFailure ? MANAGE_STORAGE_HREF : MANAGE_MODELS_HREF}
          className="inline-flex min-h-8 items-center rounded-md text-xs font-medium text-[var(--eco-primary)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]"
        >
          {isStoragePrepareFailure ? "Free up space" : "Manage Models"}
        </a>
      )}

      {onRetry && retryCanHelp && (
        <button
          type="button"
          onClick={handleRetry}
          className="mt-1 inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2 text-sm font-medium text-[var(--eco-on-primary)] transition-opacity hover:opacity-90"
          style={{ backgroundColor: "var(--eco-primary)" }}
          aria-label="Try again"
        >
          Try again
        </button>
      )}
    </div>
  );
}
