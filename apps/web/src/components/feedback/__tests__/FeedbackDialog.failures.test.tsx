// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The opt-in failure attachment: off by default, computed on tick, shown
 * verbatim, and sent only when ticked and non-empty. The preview IS the payload.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { FeedbackDialog } from "../FeedbackDialog";
import { buildFeedbackFailureSummary } from "../../../lib/feedback-failure-summary";

vi.mock("../../../lib/feedback-failure-summary", () => ({
  buildFeedbackFailureSummary: vi.fn(() => null),
}));
vi.mock("../../../lib/feedback-device-summary", () => ({
  buildFeedbackDeviceSummary: vi.fn(() => "browser: chromium"),
}));

const buildFailures = vi.mocked(buildFeedbackFailureSummary);
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function sentBody(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("FeedbackDialog — failure attachment", () => {
  it("sends nothing about failures unless the box is ticked", async () => {
    buildFailures.mockReturnValue("2026-08-26 load-fail candidate/lfm2-2.6b-onnx webgpu");
    render(<FeedbackDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Feedback message"), { target: { value: "it broke" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(buildFailures).not.toHaveBeenCalled();
    expect(sentBody()).toEqual({ message: "it broke" });
  });

  it("shows the exact text that will be sent, then sends exactly that", async () => {
    const summary = "2026-08-26 load-fail candidate/lfm2-2.6b-onnx webgpu\n2026-08-25 download-fail candidate/qwen3.5-2b-onnx insufficient-storage";
    buildFailures.mockReturnValue(summary);
    render(<FeedbackDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText(/include the last failures/i));
    expect(screen.getByTestId("feedback-failure-summary")).toHaveTextContent("load-fail candidate/lfm2-2.6b-onnx webgpu");
    fireEvent.change(screen.getByLabelText("Feedback message"), { target: { value: "it broke" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({ message: "it broke", failureSummary: summary });
  });

  it("says plainly when there is nothing to include, and sends nothing extra", async () => {
    buildFailures.mockReturnValue(null);
    render(<FeedbackDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText(/include the last failures/i));
    expect(screen.getByTestId("feedback-failure-summary")).toHaveTextContent("recorded no failures on this device");
    fireEvent.change(screen.getByLabelText("Feedback message"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({ message: "hi" });
  });
});
