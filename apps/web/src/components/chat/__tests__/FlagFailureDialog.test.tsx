// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { FlagFailureDialog, FLAG_DIALOG_AUTO_CLOSE_MS } from "../FlagFailureDialog";
import type { ChatMessage } from "../../../stores/chatStore";
import { saveCapture } from "../../../local-ai/eval/capture-store";
import { getReceiptByGenerationId } from "../../../local-ai/lifecycle/generation-receipt";
import type { CapturedFailure } from "../../../local-ai/eval/capture";

vi.mock("../../../local-ai/eval/capture-store", () => ({
  saveCapture: vi.fn(),
}));

vi.mock("../../../local-ai/lifecycle/generation-receipt", () => ({
  getReceiptByGenerationId: vi.fn(() => null),
}));

const saveCaptureMock = vi.mocked(saveCapture);
const getReceiptMock = vi.mocked(getReceiptByGenerationId);

function makeMessages(): ChatMessage[] {
  return [
    { id: "u1", role: "user", content: "tell me about ferns", createdAt: 1 },
    {
      id: "a1",
      role: "assistant",
      content: "Ferns are vascular plants.",
      createdAt: 2,
      status: "complete",
      currentGenerationId: "gen-7",
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FlagFailureDialog", () => {
  it("disables Save until a tag is chosen, then captures with tags and note", () => {
    render(
      <FlagFailureDialog
        open
        failingMessageId="a1"
        messages={makeMessages()}
        onClose={() => {}}
      />,
    );

    const save = screen.getByRole("button", { name: /save capture/i });
    expect(save).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /made something up/i }));
    expect(save).toBeEnabled();

    fireEvent.change(screen.getByLabelText(/capture note/i), {
      target: { value: "confidently wrong about spores" },
    });
    fireEvent.click(save);

    expect(saveCaptureMock).toHaveBeenCalledTimes(1);
    const capture = saveCaptureMock.mock.calls[0]![0] as CapturedFailure;
    expect(capture.prompt).toBe("tell me about ferns");
    expect(capture.failingOutput).toBe("Ferns are vascular plants.");
    expect(capture.tags).toEqual(["hallucination"]);
    expect(capture.note).toBe("confidently wrong about spores");

    // Success state replaces the form.
    expect(screen.getByText(/captured/i)).toBeInTheDocument();
  });

  it("looks up the generation receipt for provenance", () => {
    getReceiptMock.mockReturnValue({
      generationId: "gen-7",
      generationRole: "primary",
      modelId: "candidate/qwen3.5-2b-onnx",
      timestamp: 1,
      templateName: null,
      systemPromptHash: "deadbeef",
      samplingProfile: { temperature: 0.3, maxTokens: 2048, intent: "explain" },
      promptTokens: 10,
      completionTokens: 5,
      durationMs: 100,
      status: "complete",
    });

    render(
      <FlagFailureDialog
        open
        failingMessageId="a1"
        messages={makeMessages()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /formatting broke/i }));
    fireEvent.click(screen.getByRole("button", { name: /save capture/i }));

    expect(getReceiptMock).toHaveBeenCalledWith("gen-7");
    const capture = saveCaptureMock.mock.calls[0]![0] as CapturedFailure;
    expect(capture.modelId).toBe("candidate/qwen3.5-2b-onnx");
    expect(capture.intent).toBe("explain");
  });

  it("auto-closes after a successful capture", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <FlagFailureDialog
        open
        failingMessageId="a1"
        messages={makeMessages()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /too thin/i }));
    fireEvent.click(screen.getByRole("button", { name: /save capture/i }));
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(FLAG_DIALOG_AUTO_CLOSE_MS + 50);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows an error and saves nothing when the capture cannot be built", () => {
    // A lone assistant message with no preceding user turn → builder returns null.
    const messages: ChatMessage[] = [
      { id: "a0", role: "assistant", content: "hello!", createdAt: 1, status: "complete" },
    ];
    render(
      <FlagFailureDialog open failingMessageId="a0" messages={messages} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /something else/i }));
    fireEvent.click(screen.getByRole("button", { name: /save capture/i }));

    expect(saveCaptureMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn.t capture/i);
  });

  it("states the privacy posture", () => {
    render(
      <FlagFailureDialog
        open
        failingMessageId="a1"
        messages={makeMessages()}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/stays in this browser/i)).toBeInTheDocument();
  });
});
