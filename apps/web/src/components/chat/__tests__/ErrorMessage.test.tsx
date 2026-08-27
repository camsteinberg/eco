// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

// Drive the recommendation helper so we can assert the capacity-branch link
// renders only when a manual recommendation is available for the user's
// profile. The chat store mock keeps the slot stable as 'eco-fast' so the
// link's deep-link href is predictable.
type NudgeModel = {
  id: string;
  friendlyName: string;
  vendor?: string;
  sizeGB?: number;
  runtime?: string;
};

const recommendationState = vi.hoisted(() => ({
  current: null as null | {
    slot: "eco-fast" | "eco-smart";
    model: { id: string; friendlyName: string; vendor?: string; sizeGB?: number };
  },
  // Multi-candidate list for the lighter-model preference-ordering cases. When
  // set it takes precedence; otherwise `current` drives the single-candidate
  // path the capacity/lighter tests already rely on.
  list: null as null | NudgeModel[],
}));

vi.mock("../../../local-ai/selection/recommend", () => ({
  // Pass the whole model through so both the capacity nudge (friendlyName) and
  // the lighter-model nudge (id + sizeGB + runtime) can read what they need.
  listCandidates: () =>
    recommendationState.list
      ? recommendationState.list.map((model) => ({ model, score: 0.9 }))
      : recommendationState.current
        ? [{ model: recommendationState.current.model, score: 0.9 }]
        : [],
  recommend: () => null,
  NoAssignableModelError: class extends Error {},
}));

vi.mock("../../../local-ai/device/profile", () => ({
  getDeviceProfile: () => ({
    browserClass: "chromium" as const,
    webgpuSupport: true,
    deviceMemoryGB: 16,
    isMobile: false,
    override: null,
  }),
}));

vi.mock("../../../local-ai/util", () => ({
  isLocalAiSlot: (s: string) => s === "eco-fast" || s === "eco-smart",
}));

// The current slot's bound model — sizeGB is the threshold the lighter-model
// nudge filters below.
vi.mock("../../../local-ai/lifecycle/slots", () => ({
  getSlot: () => ({
    slot: "eco-fast" as const,
    modelId: "local/current-model",
    model: { id: "local/current-model", friendlyName: "Current Model", sizeGB: 3 },
    status: "ready" as const,
  }),
}));

vi.mock("../../../local-ai/catalog/catalog", () => ({
  getModel: () => null,
}));

vi.mock("../../../local-ai/download/download", () => ({
  // Runtime-aware downloaded-ness probe the lighter-model nudge consults.
  isModelDownloaded: vi.fn(async () => false),
}));

vi.mock("../../../stores/chatStore", () => ({
  useChatStore: (selector: (state: { selectedModel: string }) => unknown) =>
    selector({ selectedModel: "eco-fast" }),
}));

import { ErrorMessage } from "../ErrorMessage";
import { isModelDownloaded } from "../../../local-ai/download/download";
import {
  LOCAL_GENERATION_FALLBACK_MESSAGE,
  LOCAL_GENERATION_REPEATED_MESSAGE,
} from "../../../local-ai/adapters/error-messages";
import { MODEL_PREPARING_BUSY_MESSAGE } from "../../../lib/local-heavy-work-owner";
import { CONTEXT_WINDOW_REFUSAL_MESSAGE } from "../../../lib/context-window";
import {
  DEVICE_PROTECTION_MESSAGE,
  LOCAL_MODEL_OTHER_TAB_MESSAGE,
  TEMPLATE_MISSING_USER_MESSAGE,
} from "../../../local-ai/adapters/error-messages";

describe("ErrorMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    recommendationState.current = null;
    recommendationState.list = null;
    vi.mocked(isModelDownloaded).mockReset();
    vi.mocked(isModelDownloaded).mockResolvedValue(false);
  });

  it("renders a botanical illustration (WiltedPlantIllustration)", () => {
    const { container } = render(<ErrorMessage />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  it("renders a warm error title (not generic 'Error')", () => {
    render(<ErrorMessage />);
    // Title should NOT be the generic word "Error"
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
    // Should have a heading element with a warm message
    const heading = screen.getByRole("heading");
    expect(heading).toBeInTheDocument();
    expect(heading.textContent).toBeTruthy();
  });

  it("renders a friendly error body message", () => {
    render(<ErrorMessage />);
    // Should have body text that's not empty
    const heading = screen.getByRole("heading");
    // Body is a sibling/following paragraph
    const paragraphs = heading.parentElement?.querySelectorAll("p");
    expect(paragraphs?.length).toBeGreaterThan(0);
  });

  it("renders a 'Try again' button when onRetry is provided", () => {
    render(<ErrorMessage onRetry={() => {}} />);
    expect(
      screen.getByRole("button", { name: /try again/i })
    ).toBeInTheDocument();
  });

  it("does not render retry button when onRetry is not provided", () => {
    render(<ErrorMessage />);
    expect(
      screen.queryByRole("button", { name: /try again/i })
    ).not.toBeInTheDocument();
  });

  it("clicking 'Try again' calls onRetry after animation delay", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ErrorMessage onRetry={onRetry} />);

    await user.click(screen.getByRole("button", { name: /try again/i }));
    // onRetry should not be called immediately (animation plays first)
    expect(onRetry).not.toHaveBeenCalled();

    // Advance past the animation delay (500ms)
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("clicking 'Try again' adds perk-up class to illustration before calling onRetry", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { container } = render(<ErrorMessage onRetry={onRetry} />);

    await user.click(screen.getByRole("button", { name: /try again/i }));

    // The illustration wrapper should have perk-up class during animation
    const svg = container.querySelector("svg");
    expect(svg?.parentElement?.className ?? svg?.className ?? "").toContain(
      "perk-up"
    );
  });

  it("has accessible heading and button", () => {
    render(<ErrorMessage onRetry={() => {}} />);
    expect(screen.getByRole("heading")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /try again/i })
    ).toBeInTheDocument();
  });

  it("shows the 'open in another tab' state with its own title and keeps Try again", () => {
    render(<ErrorMessage message={LOCAL_MODEL_OTHER_TAB_MESSAGE} onRetry={() => {}} />);
    // Its own calm title — not mislabelled "Eco needs one quick setup" by the
    // setup regex (the copy contains "on-device"), which would also suppress
    // the retry the recovery relies on.
    expect(screen.getByRole("heading")).toHaveTextContent("Eco is open in another tab");
    expect(screen.queryByText(/needs one quick setup/i)).not.toBeInTheDocument();
    expect(screen.getByText(/running in another browser tab/i)).toBeInTheDocument();
    // Retrying after the other tab releases the GPU succeeds, so the action stays.
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("shows actionable local setup errors instead of a generic network message", () => {
    const onPrepareLocalModel = vi.fn();
    render(
      <ErrorMessage
        onRetry={() => {}}
        localReadiness={{
          kind: "prepare-local-model",
          modelId: "local/qwen3-0.6b",
          modelName: "Qwen3 0.6B",
          slotId: "eco-fast",
          slotLabel: "Eco Fast",
          status: "not-downloaded",
        }}
        onPrepareLocalModel={onPrepareLocalModel}
        message="Eco Fast needs preparation before Eco can answer locally. Manage Models can download it and run the readiness check."
      />,
    );

    expect(screen.getByRole("heading")).toHaveTextContent("Eco needs one quick setup");
    expect(screen.getByText(/Eco Fast needs preparation/i)).toBeInTheDocument();
    expect(screen.getByText(/only needs to happen once here/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /manage models/i })).toHaveAttribute(
      "href",
      "/settings?tab=models",
    );
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /prepare eco fast/i })).toBeInTheDocument();
  });

  it("calls prepare handler with the concrete local model ID", async () => {
    const onPrepareLocalModel = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <ErrorMessage
        localReadiness={{
          kind: "prepare-local-model",
          modelId: "local/smollm3-3b",
          modelName: "SmolLM3 3B",
          slotId: "eco-smart",
          slotLabel: "Eco Smart",
          status: "partial",
        }}
        onPrepareLocalModel={onPrepareLocalModel}
        message="Eco Smart is only partly downloaded."
      />,
    );

    await user.click(screen.getByRole("button", { name: /resume eco smart/i }));
    expect(onPrepareLocalModel).toHaveBeenCalledWith("local/smollm3-3b");
  });

  it("labels downloaded models that still need smoke readiness as test actions", () => {
    render(
      <ErrorMessage
        localReadiness={{
          kind: "prepare-local-model",
          modelId: "local/qwen3-0.6b",
          modelName: "Qwen3 0.6B",
          slotId: "eco-fast",
          slotLabel: "Eco Fast",
          status: "downloaded-needs-test",
        }}
        onPrepareLocalModel={() => {}}
        message="Eco Fast is downloaded but still needs a quick local test before Eco can answer."
      />,
    );

    expect(screen.getByRole("button", { name: /test eco fast/i })).toHaveTextContent("Test Eco Fast");
  });


  it("shows preparation progress and disables duplicate prepare clicks", () => {
    render(
      <ErrorMessage
        localReadiness={{
          kind: "prepare-local-model",
          modelId: "local/qwen3-0.6b",
          modelName: "Qwen3 0.6B",
          slotId: "eco-fast",
          slotLabel: "Eco Fast",
          status: "not-downloaded",
        }}
        localPrepareState={{ status: "downloading", progress: 0.42 }}
        onPrepareLocalModel={() => {}}
        message="Eco Fast needs preparation before Eco can answer locally."
      />,
    );

    expect(screen.getByRole("button", { name: /prepare eco fast/i })).toHaveTextContent(
      "Preparing Eco Fast 42%",
    );
    expect(screen.getByRole("button", { name: /prepare eco fast/i })).toBeDisabled();
  });

  it("shows warmup-ready state after local inference is prepared", () => {
    render(
      <ErrorMessage
        localReadiness={{
          kind: "prepare-local-model",
          modelId: "local/qwen3-0.6b",
          modelName: "Qwen3 0.6B",
          slotId: "eco-fast",
          slotLabel: "Eco Fast",
          status: "not-downloaded",
        }}
        localPrepareState={{ status: "ready" }}
        onPrepareLocalModel={() => {}}
        message="Eco Fast needs preparation before Eco can answer locally."
      />,
    );

    expect(screen.getByText(/Eco Fast is ready/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /prepare eco fast/i })).toHaveTextContent("Ready");
  });

  it("points the readiness link at storage reclaim when a prepare exhausts on disk space", () => {
    render(
      <ErrorMessage
        localReadiness={{
          kind: "prepare-local-model",
          modelId: "local/qwen3-0.6b",
          modelName: "Qwen3 0.6B",
          slotId: "eco-fast",
          slotLabel: "Eco Fast",
          status: "not-downloaded",
        }}
        localPrepareState={{
          status: "error",
          error:
            "Eco needs about 2.0 GB of free space for this model, but only about 0.3 GB is available on this device.",
        }}
        onPrepareLocalModel={() => {}}
        message="Eco Fast needs preparation before Eco can answer locally."
      />,
    );
    const link = screen.getByTestId("storage-reclaim-link");
    expect(link).toHaveAttribute("href", "/settings?tab=models&manage=storage");
    expect(link).toHaveTextContent("Free up space");
    // The vague generic label must not co-exist with the storage-specific one.
    expect(screen.queryByRole("link", { name: /manage models/i })).not.toBeInTheDocument();
  });

  it("keeps the generic Manage Models link for a non-storage prepare error", () => {
    render(
      <ErrorMessage
        localReadiness={{
          kind: "prepare-local-model",
          modelId: "local/qwen3-0.6b",
          modelName: "Qwen3 0.6B",
          slotId: "eco-fast",
          slotLabel: "Eco Fast",
          status: "not-downloaded",
        }}
        localPrepareState={{ status: "error", error: "Eco can't run on this device yet." }}
        onPrepareLocalModel={() => {}}
        message="Eco Fast needs preparation before Eco can answer locally."
      />,
    );
    expect(screen.queryByTestId("storage-reclaim-link")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /manage models/i })).toHaveAttribute(
      "href",
      "/settings?tab=models",
    );
  });

  it("shows calm cooldown copy without an immediate retry button for crash-risk states", () => {
    render(
      <ErrorMessage
        onRetry={() => {}}
        message="The graphics device needed a rest. Eco paused this model briefly and released the local worker. Try Eco Fast or wait a few minutes, then try again."
      />,
    );

    expect(screen.getByRole("heading")).toHaveTextContent("Let this device cool down");
    expect(screen.getByText(/Try Eco Fast or wait a few minutes/i)).toBeInTheDocument();
    expect(screen.queryByText(/eco network/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("renders the device-specific diagnosis attached to the browser-local-ai-not-supported marker", () => {
    render(
      <ErrorMessage
        onRetry={() => {}}
        message="browser-local-ai-not-supported: Eco does run on iPhone and iPad — it just can't run on this one yet. Updating to the latest iOS is the most likely fix."
      />,
    );
    expect(screen.getByRole("heading")).toHaveTextContent("Eco can't run on this device yet");
    // The diagnosis is the honest, profile-aware copy — it must reach the user
    // instead of a static line that tells every device to try another browser.
    expect(screen.getByText(/Updating to the latest iOS/i)).toBeInTheDocument();
    expect(screen.queryByText(/Try Chrome or Edge/i)).not.toBeInTheDocument();
    // Honest copy: the failure is local (this device can't run on-device AI),
    // there is no network fallback to mention.
    expect(screen.queryByText(/eco network/i)).not.toBeInTheDocument();
    // Must NOT use the generic "Eco needs one quick setup" wording — that
    // reads as "you need to do something" rather than "we don't support this".
    expect(screen.queryByText(/Eco needs one quick setup/i)).not.toBeInTheDocument();
    // Try again cannot succeed here: the same device still lacks the support.
    // The body already names what does work, so that is the only honest path.
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("falls back to a device-neutral line when the marker carries no guidance", () => {
    render(<ErrorMessage onRetry={() => {}} message="browser-local-ai-not-supported" />);
    expect(screen.getByRole("heading")).toHaveTextContent("Eco can't run on this device yet");
    expect(screen.getByText(/this device can't do that yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  // ─── The template-missing dead end ────────────────────────────────────────
  it("gives a broken chat template its own headline instead of the setup one", () => {
    render(<ErrorMessage onRetry={() => {}} message={TEMPLATE_MISSING_USER_MESSAGE} />);
    // The setup regex traps any message containing "download", and this copy
    // says "re-download it" — so a damaged model file used to be relabelled as
    // a setup step the user skipped.
    expect(screen.getByRole("heading")).toHaveTextContent("This model needs a fresh copy");
    expect(screen.queryByText(/Eco needs one quick setup/i)).not.toBeInTheDocument();
  });

  it("gives the template-missing card a real way to Manage Models", () => {
    render(<ErrorMessage onRetry={() => {}} message={TEMPLATE_MISSING_USER_MESSAGE} />);
    // The old card was a dead end: no button, and a body that told the user in
    // prose to go to Settings without taking them there.
    const link = screen.getByTestId("template-missing-models-link");
    expect(link).toHaveAttribute("href", "/settings?tab=models");
    // Re-running the same turn re-reads the same broken template, so Try again
    // is not offered — the link is the one action that can help.
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Re-downloading it usually fixes this/i)).toBeInTheDocument();
  });

  it("does not show the template-missing link on unrelated download-shaped errors", () => {
    render(<ErrorMessage onRetry={() => {}} message="Eco Fast is only partly downloaded." />);
    expect(screen.queryByTestId("template-missing-models-link")).not.toBeInTheDocument();
    expect(screen.getByRole("heading")).toHaveTextContent("Eco needs one quick setup");
  });

  // ─── Bundle: headline classes that must NOT read as "one quick setup" ─────
  it("titles a still-preparing model honestly and offers no action to wait with", () => {
    render(<ErrorMessage onRetry={() => {}} message={MODEL_PREPARING_BUSY_MESSAGE} />);
    expect(screen.getByRole("heading")).toHaveTextContent("Your model is still getting ready");
    // A model already warming up is not a setup task the user skipped.
    expect(screen.queryByText(/Eco needs one quick setup/i)).not.toBeInTheDocument();
    // The body says to wait for it to finish, so a filled Try again contradicts
    // the copy — and pressing it now would hit the same busy model. Like the
    // cooldown card, this one is honest about having no action.
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("titles a context-window refusal honestly and drops the re-refusing Try again", () => {
    render(<ErrorMessage onRetry={() => {}} message={CONTEXT_WINDOW_REFUSAL_MESSAGE} />);
    expect(screen.getByRole("heading")).toHaveTextContent("This conversation is too long");
    expect(screen.queryByText(/Eco needs one quick setup/i)).not.toBeInTheDocument();
    // The body says what to do (start a new chat); an unchanged retry would just
    // re-refuse, so there is no Try again button.
    expect(screen.getByText(/start a new chat/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("titles a low-battery pause honestly and keeps a way forward", () => {
    render(<ErrorMessage onRetry={() => {}} message={DEVICE_PROTECTION_MESSAGE} />);
    // The copy contains both "on-device" and "locally", which trip the setup
    // regex. A flat battery is not a setup step the user skipped, and mislabelling
    // it that way also suppressed Try again — leaving a card with NO action at all.
    expect(screen.queryByText(/Eco needs one quick setup/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading")).toHaveTextContent("Paused to protect your device");
    // The body tells them to plug in and try again, so that button must exist.
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("does NOT render the Set up link for non-capacity errors even when a recommendation exists", async () => {
    recommendationState.current = {
      slot: "eco-fast",
      model: { id: "local/qwen3-0.6b", friendlyName: "Qwen3 0.6B", vendor: "Alibaba", sizeGB: 0.6 },
    };
    // Generic error message — does NOT match the capacity regex.
    render(<ErrorMessage message="Something else went wrong." />);
    await waitFor(() => {
      expect(screen.getByRole("heading")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("capacity-local-setup-link")).not.toBeInTheDocument();
  });

  // ─── Bundle: on-device generation-failure cards ───────────────────────────
  it("titles a generic generation failure honestly and keeps Try again", () => {
    render(<ErrorMessage onRetry={() => {}} message={LOCAL_GENERATION_FALLBACK_MESSAGE} />);
    expect(screen.getByRole("heading")).toHaveTextContent("That reply hit a snag");
    // It must NOT be mistaken for a setup problem.
    expect(screen.queryByText(/Eco needs one quick setup/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("offers a lighter model on the repeated-failure card", async () => {
    recommendationState.current = {
      slot: "eco-fast",
      // Strictly lighter than the current (sizeGB 3) slot model.
      model: {
        id: "local/bonsai-lite",
        friendlyName: "Bonsai Lite",
        vendor: "Eco",
        sizeGB: 1,
      },
    };
    render(<ErrorMessage onRetry={() => {}} message={LOCAL_GENERATION_REPEATED_MESSAGE} />);
    expect(screen.getByRole("heading")).toHaveTextContent("That reply hit a snag");
    await waitFor(() => {
      expect(screen.getByTestId("lighter-model-setup-link")).toBeInTheDocument();
    });
    const link = screen.getByTestId("lighter-model-setup-link");
    expect(link).toHaveAttribute("href", "/settings?tab=models&setup=eco-fast");
    expect(link).toHaveTextContent(/Set up Bonsai Lite/);
    // Same single-text-run requirement as the capacity branch: this link is
    // `inline-flex`, and a whitespace-only node between text runs is dropped.
    expect(link.textContent).toBe("Set up Bonsai Lite on this device →");
    expect(link.childNodes).toHaveLength(1);
    expect(link.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  });

  it("brands the lighter-model name the same way the choice surfaces do", async () => {
    recommendationState.current = {
      slot: "eco-fast",
      // A catalogued model, lighter than the current (sizeGB 3) slot model.
      model: {
        id: "candidate/lfm2.5-350m-onnx",
        friendlyName: "LFM2.5 350M",
        vendor: "Liquid AI",
        sizeGB: 0.4,
      },
    };
    render(<ErrorMessage onRetry={() => {}} message={LOCAL_GENERATION_REPEATED_MESSAGE} />);
    await waitFor(() => {
      expect(screen.getByTestId("lighter-model-setup-link")).toBeInTheDocument();
    });
    const link = screen.getByTestId("lighter-model-setup-link");
    expect(link).toHaveTextContent(/Set up Eco Light \(Liquid\)/);
    expect(link).not.toHaveTextContent(/LFM2\.5 350M/);
  });

  it("prefers an already-downloaded lighter webllm candidate over a lighter uncached one (runtime-aware)", async () => {
    // Two lighter candidates; the second is a webllm model already in WebLLM's
    // cache. A bare Eco-cache probe would miss it and offer the first (a
    // download); the runtime-aware probe must pick the cached webllm one for the
    // one-tap switch.
    recommendationState.list = [
      { id: "local/onnx-lite", friendlyName: "Onnx Lite", vendor: "Eco", sizeGB: 1.5 },
      {
        id: "local/webllm-lite",
        friendlyName: "WebLLM Lite",
        vendor: "Eco",
        sizeGB: 2,
        runtime: "webllm",
      },
    ];
    vi.mocked(isModelDownloaded).mockImplementation(
      async (m) => (m as { id: string }).id === "local/webllm-lite",
    );
    render(<ErrorMessage onRetry={() => {}} message={LOCAL_GENERATION_REPEATED_MESSAGE} />);
    await waitFor(() => {
      expect(screen.getByTestId("lighter-model-setup-link")).toBeInTheDocument();
    });
    expect(screen.getByTestId("lighter-model-setup-link")).toHaveTextContent(/Set up WebLLM Lite/);
  });

  it("keeps the cooldown title for the warmed 'needs a short breather' copy", () => {
    render(
      <ErrorMessage
        onRetry={() => {}}
        message="On-device AI needs a short breather after a snag — try again in about 2 minutes."
      />,
    );
    expect(screen.getByRole("heading")).toHaveTextContent("Let this device cool down");
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });
});

// No-excuse-UI: this is a local-first app — when a generation fails on the
// user's own device, nobody at Eco is "on it". The card must never promise
// invisible help (verified live 2026-08-05: "We are on it; try again shortly").
describe("generic fallback copy", () => {
  it("never promises that somebody is working on a local failure", () => {
    // The generic pool is hash-picked from the message string — render enough
    // distinct messages to hit every entry in the pool.
    for (let i = 0; i < 12; i++) {
      const { unmount } = render(<ErrorMessage message={`unclassified failure ${String(i)}`} />);
      const alert = screen.getByRole("alert");
      expect(alert.textContent).not.toMatch(/we.?re on it|we are on it|try again shortly/i);
      unmount();
    }
  });
});
