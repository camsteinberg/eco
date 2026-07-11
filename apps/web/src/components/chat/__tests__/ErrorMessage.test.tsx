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
const recommendationState = vi.hoisted(() => ({
  current: null as null | {
    slot: "eco-fast" | "eco-smart";
    model: { id: string; friendlyName: string; sizeGB?: number };
  },
}));

vi.mock("../../../local-ai/selection/recommend", () => ({
  // Pass the whole model through so both the capacity nudge (friendlyName) and
  // the lighter-model nudge (id + sizeGB) can read what they need.
  listCandidates: () =>
    recommendationState.current
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
  isModelFullyCached: async () => false,
}));

vi.mock("../../../stores/chatStore", () => ({
  useChatStore: (selector: (state: { selectedModel: string }) => unknown) =>
    selector({ selectedModel: "eco-fast" }),
}));

import { ErrorMessage } from "../ErrorMessage";
import {
  LOCAL_GENERATION_FALLBACK_MESSAGE,
  LOCAL_GENERATION_REPEATED_MESSAGE,
} from "../../../local-ai/adapters/error-messages";
import { MODEL_PREPARING_BUSY_MESSAGE } from "../../../lib/local-heavy-work-owner";
import { CONTEXT_WINDOW_REFUSAL_MESSAGE } from "../../../lib/context-window";

describe("ErrorMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    recommendationState.current = null;
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

  it("shows a calm, on-device interruption message without network references", () => {
    render(<ErrorMessage message="No contributor available" />);
    const heading = screen.getByRole("heading");
    expect(heading).toHaveTextContent("Something interrupted that response");
    expect(screen.getByText(/your turn stays right here in this chat/i)).toBeInTheDocument();
    expect(screen.queryByText(/eco network/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/contributors/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/miner/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/p2p/i)).not.toBeInTheDocument();
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

  it("renders honest browser-unsupported copy when the message carries the browser-local-ai-not-supported marker", () => {
    render(
      <ErrorMessage
        onRetry={() => {}}
        message="browser-local-ai-not-supported: Eco hasn't validated Safari yet."
      />,
    );
    expect(screen.getByRole("heading")).toHaveTextContent("Eco isn't ready for this browser yet");
    expect(screen.getByText(/Try Chrome or Edge on a recent device/i)).toBeInTheDocument();
    // Honest copy: the failure is local (this browser can't run on-device AI),
    // there is no network fallback to mention.
    expect(screen.queryByText(/eco network/i)).not.toBeInTheDocument();
    // Must NOT use the generic "Eco needs one quick setup" wording — that
    // reads as "you need to do something" rather than "we don't support this".
    expect(screen.queryByText(/Eco needs one quick setup/i)).not.toBeInTheDocument();
  });

  // ─── Bundle: headline classes that must NOT read as "one quick setup" ─────
  it("titles a still-preparing model honestly and keeps Try again", () => {
    render(<ErrorMessage onRetry={() => {}} message={MODEL_PREPARING_BUSY_MESSAGE} />);
    expect(screen.getByRole("heading")).toHaveTextContent("Your model is still getting ready");
    // A model already warming up is not a setup task the user skipped.
    expect(screen.queryByText(/Eco needs one quick setup/i)).not.toBeInTheDocument();
    // Waiting then retrying is the right action here, so Try again stays.
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("titles a context-window refusal honestly and drops the re-refusing Try again", () => {
    render(<ErrorMessage onRetry={() => {}} message={CONTEXT_WINDOW_REFUSAL_MESSAGE} />);
    expect(screen.getByRole("heading")).toHaveTextContent("This conversation is too long");
    expect(screen.queryByText(/Eco needs one quick setup/i)).not.toBeInTheDocument();
    // The body says what to do (trim / shorten); an unchanged retry would just
    // re-refuse, so there is no Try again button.
    expect(screen.getByText(/trim the long chat or file/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  // ─── Bundle 3: capacity-error local-setup link ────────────────────────────
  it("renders a Set up <model> link in the capacity branch when a manual recommendation exists", async () => {
    recommendationState.current = {
      slot: "eco-fast",
      model: { id: "local/qwen3-0.6b", friendlyName: "Qwen3 0.6B" },
    };
    render(<ErrorMessage message="No contributor available — capacity busy" />);
    await waitFor(() => {
      expect(screen.getByTestId("capacity-local-setup-link")).toBeInTheDocument();
    });
    const link = screen.getByTestId("capacity-local-setup-link");
    expect(link).toHaveAttribute("href", "/settings?tab=models&setup=eco-fast");
    expect(link).toHaveTextContent(/Set up Qwen3 0\.6B/);
  });

  it("does NOT render the Set up link when no manual recommendation exists", async () => {
    recommendationState.current = null;
    render(<ErrorMessage message="No contributor available — capacity busy" />);
    // Tick to allow the effect to run + assert the link still isn't present.
    await waitFor(() => {
      expect(screen.getByRole("heading")).toHaveTextContent("Something interrupted that response");
    });
    expect(screen.queryByTestId("capacity-local-setup-link")).not.toBeInTheDocument();
  });

  it("does NOT render the Set up link for non-capacity errors even when a recommendation exists", async () => {
    recommendationState.current = {
      slot: "eco-fast",
      model: { id: "local/qwen3-0.6b", friendlyName: "Qwen3 0.6B" },
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
      model: { id: "local/bonsai-lite", friendlyName: "Bonsai Lite", sizeGB: 1 },
    };
    render(<ErrorMessage onRetry={() => {}} message={LOCAL_GENERATION_REPEATED_MESSAGE} />);
    expect(screen.getByRole("heading")).toHaveTextContent("That reply hit a snag");
    await waitFor(() => {
      expect(screen.getByTestId("lighter-model-setup-link")).toBeInTheDocument();
    });
    const link = screen.getByTestId("lighter-model-setup-link");
    expect(link).toHaveAttribute("href", "/settings?tab=models&setup=eco-fast");
    expect(link).toHaveTextContent(/Set up Bonsai Lite/);
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
