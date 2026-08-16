// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import React from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { MessageBubble } from "../MessageBubble";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useChatStore } from "../../../stores/chatStore";
import type { Citation } from "../../../lib/citation-parser";
import type { ToolCallDisplay } from "../../../lib/tool-parser";

vi.mock("../MarkdownRenderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));

vi.mock("../StreamingCursor", () => ({
  StreamingCursor: ({ phase }: { phase?: string }) => (
    <span data-testid="cursor" data-phase={phase ?? "generating"} />
  ),
}));

vi.mock("../../EcoLogo", () => ({
  EcoLogo: () => <span data-testid="eco-logo" />,
}));

vi.mock("../ThinkingBlock", () => ({
  ThinkingBlock: ({ content }: { content: string }) => (
    <div data-testid="thinking-block">{content}</div>
  ),
}));

vi.mock("motion/react", () => {
  const makeComponent = (tag: string) => {
    const Component = (props: Record<string, unknown>) => {
      const {
        children,
        initial: _i,
        animate: _a,
        exit: _e,
        transition: _t,
        whileHover: _wh,
        whileTap: _wt,
        variants: _v,
        layout: _l,
        ...rest
      } = props;
      return React.createElement(tag, rest, children as React.ReactNode);
    };
    Component.displayName = `motion.${tag}`;
    return Component;
  };
  const motion = new Proxy({} as Record<string, unknown>, {
    get: (target, prop: string) => {
      target[prop] ??= makeComponent(prop);
      return target[prop];
    },
  });
  return {
    motion,
    useReducedMotion: () => false,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock("@eco/ui", () => ({
  getTransition: () => ({ duration: 0 }),
}));

describe("MessageBubble", () => {
  afterEach(() => {
    // Restore default preferences between tests so grounding-notice gating and
    // technical-details rows don't leak across cases.
    useSettingsStore.setState({ showTechnicalDetails: false, groundingNoticeSeen: false });
  });

  it("renders user message content", () => {
    render(<MessageBubble role="user" content="Hello world" />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders assistant message content", () => {
    render(<MessageBubble role="assistant" content="Hi there" />);
    expect(screen.getByText("Hi there")).toBeInTheDocument();
  });

  it("keeps assistant replies free of persistent privacy badges", () => {
    render(
      <MessageBubble
        role="assistant"
        content="response"
        tokenCount={100}
      />
    );
    expect(screen.queryByText("On-Device")).not.toBeInTheDocument();
  });

  it("hides the token-count chip by default (technical details off)", () => {
    render(
      <MessageBubble
        role="assistant"
        content="response"
        tokenCount={100}
        status="complete"
      />
    );
    expect(screen.queryByText(/100 tokens/)).not.toBeInTheDocument();
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
  });

  it("shows the token-count chip when technical details are enabled", () => {
    useSettingsStore.setState({ showTechnicalDetails: true });
    render(
      <MessageBubble
        role="assistant"
        content="response"
        tokenCount={100}
        status="complete"
      />
    );
    expect(screen.getByText(/100 tokens/)).toBeInTheDocument();
  });

  it("hides the streaming token rate by default (technical details off)", () => {
    render(
      <MessageBubble
        role="assistant"
        content="partial"
        isStreaming
        status="streaming"
        tokenCount={20}
        streamStartTime={Date.now() - 2000}
      />
    );
    expect(screen.queryByText(/tok\/s/)).not.toBeInTheDocument();
  });

  it("shows the streaming token rate when technical details are enabled", () => {
    useSettingsStore.setState({ showTechnicalDetails: true });
    render(
      <MessageBubble
        role="assistant"
        content="partial"
        isStreaming
        status="streaming"
        tokenCount={20}
        streamStartTime={Date.now() - 2000}
      />
    );
    expect(screen.getByText(/tok\/s/)).toBeInTheDocument();
  });

  it("does not render auto model tags under assistant replies", () => {
    render(
      <MessageBubble
        role="assistant"
        content="local response"
        resolvedModel="llama-3.1-8b-q4_k_m"
      />
    );
    expect(screen.queryByText(/^Auto$/)).not.toBeInTheDocument();
  });

  it("does not render Eco Network CTAs under low-confidence local replies", () => {
    render(
      <MessageBubble
        role="assistant"
        content="I'm not sure."
        inferenceMethod="local"
        confidence={0.2}
        onReask={vi.fn()}
        promptContent="What happened today?"
      />,
    );

    expect(screen.queryByText(/Ask the Eco Network/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Eco Network/i })).not.toBeInTheDocument();
  });

  it("keeps freshness-sensitive prompts free of network marketing in launch chat", () => {
    render(
      <MessageBubble
        role="assistant"
        content="I can't verify current events from here."
        inferenceMethod="local"
        confidence={null}
        onReask={vi.fn()}
        promptContent="What is the latest news today?"
      />,
    );

    expect(screen.queryByText(/Need a current answer/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Eco Network/i)).not.toBeInTheDocument();
  });

  it("renders ThinkingBlock when content starts with <think> tag", () => {
    render(
      <MessageBubble
        role="assistant"
        content="<think>Let me reason about this...</think>Here is my answer"
      />
    );
    const thinkBlock = screen.getByTestId("thinking-block");
    expect(thinkBlock).toBeInTheDocument();
    expect(thinkBlock).toHaveTextContent("Let me reason about this...");
    // The display content should not include the think tags
    expect(screen.getByText("Here is my answer")).toBeInTheDocument();
  });

  it("does not render ThinkingBlock for user messages", () => {
    render(
      <MessageBubble
        role="user"
        content="<think>This is a user message</think>Hello"
      />
    );
    expect(screen.queryByTestId("thinking-block")).not.toBeInTheDocument();
  });

  it("does not render persistent privacy labels for user messages", () => {
    render(
      <MessageBubble
        role="user"
        content="Hello"
      />
    );
    expect(screen.queryByText("Encrypted")).not.toBeInTheDocument();
  });

  it("shows branded error component when status is error", () => {
    render(
      <MessageBubble
        role="assistant"
        content=""
        status="error"
        errorMessage="Network error"
      />
    );
    // ErrorMessage renders a warm heading, not the raw error string
    const heading = screen.getByRole("heading");
    expect(heading).toBeInTheDocument();
    // The heading should NOT be generic "Error"
    expect(heading.textContent).not.toBe("Error");
  });

  it("shows branded error when no errorMessage provided", () => {
    render(
      <MessageBubble role="assistant" content="" status="error" />
    );
    // Should still render the branded error component with a heading
    const heading = screen.getByRole("heading");
    expect(heading).toBeInTheDocument();
  });

  it("shows try again button when onRetry is provided", () => {
    const onRetry = vi.fn();
    render(
      <MessageBubble
        role="assistant"
        content=""
        status="error"
        errorMessage="Something went wrong"
        onRetry={onRetry}
      />
    );
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("calls onRetry when try again button is clicked (with animation delay)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onRetry = vi.fn();
    render(
      <MessageBubble
        role="assistant"
        content=""
        status="error"
        errorMessage="Something went wrong"
        onRetry={onRetry}
      />
    );
    await user.click(screen.getByRole("button", { name: /try again/i }));
    // ErrorMessage uses a 500ms perk animation delay before calling onRetry
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("passes local readiness prepare actions through error rendering", async () => {
    const user = userEvent.setup();
    const onPrepareLocalModel = vi.fn();
    render(
      <MessageBubble
        role="assistant"
        content=""
        status="error"
        errorMessage="Eco Fast needs to be downloaded before Eco can answer locally."
        localReadiness={{
          kind: "prepare-local-model",
          modelId: "local/qwen3-0.6b",
          modelName: "Qwen3 0.6B",
          slotId: "eco-fast",
          slotLabel: "Eco Fast",
          status: "not-downloaded",
        }}
        onPrepareLocalModel={onPrepareLocalModel}
      />,
    );

    await user.click(screen.getByRole("button", { name: /prepare eco fast/i }));
    expect(onPrepareLocalModel).toHaveBeenCalledWith("local/qwen3-0.6b");
  });

  it("does not show error section when status is not error", () => {
    render(
      <MessageBubble role="assistant" content="Working fine" status="complete" />
    );
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("offers continuation when a local reply may have reached its limit", async () => {
    const user = userEvent.setup();
    const onAssistantAction = vi.fn();
    render(
      <MessageBubble
        role="assistant"
        content="Partial local answer"
        status="complete"
        possiblyTruncated
        onAssistantAction={onAssistantAction}
      />,
    );

    expect(screen.getByText(/may have reached its length limit/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(onAssistantAction).toHaveBeenCalledWith("continue");
  });

  it("renders thinking chip with dots but no label text for default streaming state", () => {
    render(
      <MessageBubble
        role="assistant"
        content=""
        isStreaming
        status="streaming"
      />,
    );
    const cursor = screen.getByTestId("cursor");
    expect(cursor).toBeInTheDocument();
    expect(cursor).toHaveAttribute("data-phase", "thinking");
    // Chip wrapper IS present so the dots have visual grounding
    expect(cursor.closest(".rounded-full")).not.toBeNull();
    // But no label text alongside the dots
    expect(screen.queryByText("Preparing a thoughtful answer")).not.toBeInTheDocument();
  });

  it("renders thinking chip with dots but no label when streamPhase is 'generating'", () => {
    render(
      <MessageBubble
        role="assistant"
        content=""
        isStreaming
        streamPhase="generating"
        status="streaming"
      />,
    );
    const cursor = screen.getByTestId("cursor");
    expect(cursor).toBeInTheDocument();
    expect(cursor).toHaveAttribute("data-phase", "thinking");
    expect(cursor.closest(".rounded-full")).not.toBeNull();
    expect(screen.queryByText("Preparing a thoughtful answer")).not.toBeInTheDocument();
  });

  it("renders a dots-only chip (no network label) for queued streaming phase", () => {
    render(
      <MessageBubble
        role="assistant"
        content=""
        isStreaming
        streamPhase="queued"
        status="streaming"
      />,
    );
    // On-device only: there is no network capacity to check, so the queued
    // phase shows the breathing cursor with no label.
    expect(screen.queryByText(/eco network/i)).not.toBeInTheDocument();
    const cursor = screen.getByTestId("cursor");
    expect(cursor).toHaveAttribute("data-phase", "queued");
  });

  it("renders chip with label for tool-executing streaming phase", () => {
    render(
      <MessageBubble
        role="assistant"
        content=""
        isStreaming
        streamPhase="tool-executing"
        status="streaming"
      />,
    );
    expect(screen.getByText("Working with tools")).toBeInTheDocument();
    const cursor = screen.getByTestId("cursor");
    expect(cursor).toHaveAttribute("data-phase", "tool-executing");
  });

  it("names the web for the looking-up streaming phase (a live grounding lookup)", () => {
    // Honest in-the-moment signal: a web lookup is the one moment a user learns
    // their question is leaving the device, so the pill names the web plainly
    // rather than the generic "Working with tools".
    render(
      <MessageBubble
        role="assistant"
        content=""
        isStreaming
        streamPhase="looking-up"
        status="streaming"
      />,
    );
    expect(screen.getByText("Looking this up on the web…")).toBeInTheDocument();
    expect(screen.queryByText("Working with tools")).not.toBeInTheDocument();
    const cursor = screen.getByTestId("cursor");
    expect(cursor).toHaveAttribute("data-phase", "looking-up");
  });

  it("renders honest 'Warming up Eco…' label + loading cursor for loading streaming phase", () => {
    // Cold-load window (#4 W3a): the model is warming up before the first token,
    // so the prelude must say so honestly rather than show undifferentiated dots.
    render(
      <MessageBubble
        role="assistant"
        content=""
        isStreaming
        streamPhase="loading"
        status="streaming"
      />,
    );
    expect(screen.getByText("Warming up Eco…")).toBeInTheDocument();
    const cursor = screen.getByTestId("cursor");
    // The loading phase passes through the prelude normalization unchanged
    // (only generating/missing collapse to thinking).
    expect(cursor).toHaveAttribute("data-phase", "loading");
  });

  describe("cold-load prelude (time-aware copy escalation)", () => {
    function renderLoading() {
      return render(
        <MessageBubble
          role="assistant"
          content=""
          isStreaming
          streamPhase="loading"
          status="streaming"
        />,
      );
    }

    afterEach(() => {
      // The prelude subscribes to the real chatStore; clear the cold-load signal
      // so an "almost ready" set in one case can't leak into the next.
      useChatStore.setState({ loadAlmostReady: false });
    });

    it("starts at tier 1 ('Warming up Eco…') with no later-tier copy", () => {
      renderLoading();
      expect(screen.getByText("Warming up Eco…")).toBeInTheDocument();
      expect(screen.queryByText(/runs privately on your device/)).not.toBeInTheDocument();
      expect(screen.queryByText(/take a few minutes/)).not.toBeInTheDocument();
    });

    it("escalates copy to tier 2 at 9s and tier 3 at 45s", () => {
      vi.useFakeTimers();
      try {
        useChatStore.setState({ loadAlmostReady: false });
        renderLoading();
        expect(screen.getByText("Warming up Eco…")).toBeInTheDocument();

        act(() => {
          vi.advanceTimersByTime(9_000);
        });
        expect(screen.getByText(/Still warming up/)).toBeInTheDocument();
        expect(screen.queryByText("Warming up Eco…")).not.toBeInTheDocument();

        act(() => {
          vi.advanceTimersByTime(36_000); // total 45s
        });
        expect(screen.getByText(/Still working/)).toBeInTheDocument();
        expect(screen.queryByText(/Still warming up/)).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("'Almost ready' override wins at any elapsed time", () => {
      vi.useFakeTimers();
      try {
        useChatStore.setState({ loadAlmostReady: true });
        renderLoading();
        // Wins immediately, before any time tier could apply.
        expect(screen.getByText(/Almost ready/)).toBeInTheDocument();
        expect(screen.queryByText("Warming up Eco…")).not.toBeInTheDocument();

        // And still wins after the wait passes the tier-3 threshold.
        act(() => {
          vi.advanceTimersByTime(60_000);
        });
        expect(screen.getByText(/Almost ready/)).toBeInTheDocument();
        expect(screen.queryByText(/Still working/)).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("announces the label via an aria-live=polite region", () => {
      renderLoading();
      const region = screen.getByText("Warming up Eco…").closest('[aria-live="polite"]');
      expect(region).not.toBeNull();
    });

    it("clears the elapsed-time interval on unmount (no leaked timers)", () => {
      vi.useFakeTimers();
      try {
        const { unmount } = renderLoading();
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        unmount();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears the loading interval when the phase leaves loading", () => {
      vi.useFakeTimers();
      try {
        const { rerender } = renderLoading();
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        // Phase → generating unmounts LoadingPrelude (clearing its 1s
        // interval) and mounts ThinkingPrelude, which owns exactly one
        // pending timer: the 4s label timeout.
        rerender(
          <MessageBubble
            role="assistant"
            content=""
            isStreaming
            streamPhase="generating"
            status="streaming"
          />,
        );
        expect(vi.getTimerCount()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("warm 'thinking' path shows dots first, then the honest prefill label after 4s", () => {
      vi.useFakeTimers();
      try {
        const { unmount } = render(
          <MessageBubble
            role="assistant"
            content=""
            isStreaming
            streamPhase="thinking"
            status="streaming"
          />,
        );
        expect(screen.getByTestId("cursor")).toHaveAttribute("data-phase", "thinking");
        // No loading-ladder copy, and no label before the threshold.
        expect(screen.queryByText("Warming up Eco…")).not.toBeInTheDocument();
        expect(screen.queryByText(/runs privately on your device/)).not.toBeInTheDocument();
        expect(screen.queryByText("Reading over the conversation…")).not.toBeInTheDocument();

        act(() => {
          vi.advanceTimersByTime(4_000);
        });
        expect(screen.getByText("Reading over the conversation…")).toBeInTheDocument();

        // Unmount clears the (already-fired or pending) timeout.
        unmount();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("grounding disclosure notice (once per chat — first grounded message)", () => {
    const groundedCitations: Citation[] = [
      {
        id: 1,
        title: "Photosynthesis",
        url: "https://en.wikipedia.org/wiki/Photosynthesis",
        source: "Wikipedia",
        asOf: "2023",
      },
    ];
    // A citation with NO `source` is the research/defensive path — not grounding.
    const ungroundedCitations: Citation[] = [
      { id: 1, title: "Some note", url: "https://example.com/a" },
    ];

    it("shows the notice on the FIRST grounded answer when unseen", () => {
      render(
        <MessageBubble
          role="assistant"
          content="Plants make food from light."
          status="complete"
          isFirstGrounded
          citations={groundedCitations}
        />,
      );
      expect(screen.getByTestId("grounding-notice")).toBeInTheDocument();
    });

    it("hides the notice once it has been seen (global opt-out)", () => {
      useSettingsStore.setState({ groundingNoticeSeen: true });
      render(
        <MessageBubble
          role="assistant"
          content="Plants make food from light."
          status="complete"
          isFirstGrounded
          citations={groundedCitations}
        />,
      );
      expect(screen.queryByTestId("grounding-notice")).not.toBeInTheDocument();
    });

    it("hides the notice while the message is streaming", () => {
      render(
        <MessageBubble
          role="assistant"
          content="Plants make food from light."
          isStreaming
          isFirstGrounded
          citations={groundedCitations}
        />,
      );
      expect(screen.queryByTestId("grounding-notice")).not.toBeInTheDocument();
    });

    it("hides the notice on a LATER grounded message (not the first in the chat)", () => {
      render(
        <MessageBubble
          role="assistant"
          content="Plants make food from light."
          status="complete"
          isFirstGrounded={false}
          citations={groundedCitations}
        />,
      );
      expect(screen.queryByTestId("grounding-notice")).not.toBeInTheDocument();
    });

    it("hides the notice on a message with no grounding citation", () => {
      render(
        <MessageBubble
          role="assistant"
          content="Just a plain answer."
          status="complete"
          isFirstGrounded
          citations={ungroundedCitations}
        />,
      );
      expect(screen.queryByTestId("grounding-notice")).not.toBeInTheDocument();
    });

    it("hides the notice when there are no citations at all", () => {
      render(
        <MessageBubble
          role="assistant"
          content="Just a plain answer."
          status="complete"
          isFirstGrounded
        />,
      );
      expect(screen.queryByTestId("grounding-notice")).not.toBeInTheDocument();
    });
  });

  describe("uncertainty marker (couldn't-confirm-this — honest counterpart to the chip)", () => {
    const groundedCitations: Citation[] = [
      {
        id: 1,
        title: "Photosynthesis",
        url: "https://en.wikipedia.org/wiki/Photosynthesis",
        source: "Wikipedia",
        asOf: "2023",
      },
    ];

    it("renders the marker on a finished reply when verification is set and there's no sourced citation", () => {
      render(
        <MessageBubble
          role="assistant"
          content="It might be around 30 metres, but I'm not certain."
          status="complete"
          verification={{ status: "unverified" }}
        />,
      );
      const note = screen.getByTestId("uncertainty-note");
      expect(note).toBeInTheDocument();
      expect(note).toHaveTextContent(/couldn.t confirm this against a source/i);
    });

    it("renders the transient copy for the unreachable status", () => {
      render(
        <MessageBubble
          role="assistant"
          content="I couldn't look that up right now."
          status="complete"
          verification={{ status: "unreachable" }}
        />,
      );
      expect(screen.getByTestId("uncertainty-note")).toHaveTextContent(
        /couldn.t reach its sources/i,
      );
    });

    it("does NOT render the marker when a sourced citation is present (mutual exclusion)", () => {
      // A turn is FOUND xor not: a sourced citation means the chip renders, never the marker.
      render(
        <MessageBubble
          role="assistant"
          content="Plants make food from light."
          status="complete"
          citations={groundedCitations}
          verification={{ status: "unverified" }}
        />,
      );
      expect(screen.queryByTestId("uncertainty-note")).not.toBeInTheDocument();
      expect(screen.getByTestId("grounding-citation")).toBeInTheDocument();
    });

    it("does NOT render the marker while the message is streaming", () => {
      render(
        <MessageBubble
          role="assistant"
          content="It might be around 30 metres"
          isStreaming
          verification={{ status: "unverified" }}
        />,
      );
      expect(screen.queryByTestId("uncertainty-note")).not.toBeInTheDocument();
    });

    it("does NOT render the marker when verification is absent", () => {
      render(
        <MessageBubble role="assistant" content="A plain answer." status="complete" />,
      );
      expect(screen.queryByTestId("uncertainty-note")).not.toBeInTheDocument();
    });

    it("does NOT render the marker on an error card even when verification is set", () => {
      // A generation-fault error card must not sprout a grounding uncertainty
      // note — the verification is stale context from the failed turn.
      render(
        <MessageBubble
          role="assistant"
          content="On-device AI hit a snag."
          status="error"
          verification={{ status: "unverified" }}
        />,
      );
      expect(screen.queryByTestId("uncertainty-note")).not.toBeInTheDocument();
    });
  });

  describe("canonical tool answer (host-computed exact value wins over model prose)", () => {
    const canonicalCall = (
      overrides: Partial<ToolCallDisplay> = {},
    ): ToolCallDisplay => ({
      id: "tool-1",
      type: "tool_complete",
      name: "calculator",
      status: "complete",
      presentation: "tool-block",
      result: "2 + 2 = 4",
      summary: "2 × 2",
      args: { expression: "2 + 2" },
      ...overrides,
    });

    it("surfaces the tool's EXACT result and suppresses the model's wrong prose number", () => {
      // The regression that ships the launch bug: a sub-1B starter writes a wrong
      // number in prose while the correct value sits in the tool result. The
      // canonical value must be the visible answer; the contradicting prose must not.
      render(
        <MessageBubble
          role="assistant"
          content="2 + 2 = 5"
          status="complete"
          toolCalls={[canonicalCall()]}
        />,
      );

      // The host-computed answer is surfaced authoritatively.
      const answer = screen.getByTestId("canonical-tool-answer");
      expect(answer).toHaveTextContent("2 + 2 = 4");
      // The model's contradicting prose is nowhere on screen (MarkdownRenderer is
      // mocked to echo its content, so its absence proves the prose was suppressed).
      expect(screen.queryByText("2 + 2 = 5")).not.toBeInTheDocument();
      // The quiet provenance receipt still renders below the answer.
      expect(screen.getByText("Calculator")).toBeInTheDocument();
    });

    it("suppresses prose while the tool is still running (no answer shown yet)", () => {
      render(
        <MessageBubble
          role="assistant"
          content="thinking out loud with a wrong 5"
          isStreaming
          status="streaming"
          toolCalls={[canonicalCall({ status: "running", type: "tool_start", result: undefined })]}
        />,
      );
      // No canonical answer until the tool settles…
      expect(screen.queryByTestId("canonical-tool-answer")).not.toBeInTheDocument();
      // …and the model's prose is never rendered for a canonical turn.
      expect(screen.queryByText(/thinking out loud/)).not.toBeInTheDocument();
    });

    it("renders the model prose normally for a non-'tool-block' call (strict keying)", () => {
      // A tool call WITHOUT presentation:"tool-block" (e.g. a future model-native
      // block) is not a canonical exact answer — the model's prose must still show.
      render(
        <MessageBubble
          role="assistant"
          content="Here is the natural answer."
          status="complete"
          toolCalls={[canonicalCall({ presentation: undefined, name: "code_execution" })]}
        />,
      );
      expect(screen.getByText("Here is the natural answer.")).toBeInTheDocument();
      expect(screen.queryByTestId("canonical-tool-answer")).not.toBeInTheDocument();
    });

    it("PERSISTED turn (canonicalToolAnswer flag, NO live toolCalls) still renders the exact value — the scroll-back fix", () => {
      // After a follow-up, the previous canonical turn loses its transient
      // `toolCalls` side-channel (it only ever reaches the LAST assistant message).
      // The persisted flag + content is what keeps the exact value on screen. Guard
      // against the launch bug: the persisted content is the CORRECT value, never the
      // model's wrong prose — so scroll-back shows "17 * 23 = 391", not "= 390".
      render(
        <MessageBubble
          role="assistant"
          content="17 * 23 = 391"
          status="complete"
          canonicalToolAnswer
        />,
      );

      const answer = screen.getByTestId("canonical-tool-answer");
      expect(answer).toHaveTextContent("17 * 23 = 391");
    });

    it("does NOT double-render the persisted value (canonical <p> only, no MarkdownRenderer pass)", () => {
      // The canonical branch and the Markdown branch are mutually exclusive — the
      // value must appear exactly once, from the canonical <p>. (MarkdownRenderer is
      // mocked to echo, so a second copy would surface a duplicate.)
      render(
        <MessageBubble
          role="assistant"
          content="2 + 2 = 4"
          status="complete"
          canonicalToolAnswer
        />,
      );

      expect(screen.getAllByText("2 + 2 = 4")).toHaveLength(1);
      expect(screen.getByTestId("canonical-tool-answer")).toBeInTheDocument();
    });

    it("renders the honest failure display on a persisted ok:false canonical turn (no fabricated number)", () => {
      render(
        <MessageBubble
          role="assistant"
          content={'Couldn\'t compute "1 / 0" — division by zero.'}
          status="complete"
          canonicalToolAnswer
        />,
      );

      const answer = screen.getByTestId("canonical-tool-answer");
      expect(answer).toHaveTextContent("Couldn't compute");
    });

    it("leaves an ordinary assistant turn (no flag, no toolCalls) on the Markdown path", () => {
      // Regression guard: the persisted flag must be the ONLY thing that triggers
      // canonical rendering on a non-last message — a plain reply stays Markdown.
      render(
        <MessageBubble role="assistant" content="A normal answer." status="complete" />,
      );

      expect(screen.getByText("A normal answer.")).toBeInTheDocument();
      expect(screen.queryByTestId("canonical-tool-answer")).not.toBeInTheDocument();
    });
  });
});
