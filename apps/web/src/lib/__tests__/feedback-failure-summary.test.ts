// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildFeedbackFailureSummary, MAX_FAILURE_ROWS } from "../feedback-failure-summary";
import { readAllEntries, type LedgerEntry } from "../../local-ai/evidence/ledger";

vi.mock("../../local-ai/evidence/ledger", () => ({
  readAllEntries: vi.fn(() => []),
}));

const readAll = vi.mocked(readAllEntries);

function row(over: Partial<LedgerEntry>): LedgerEntry {
  return {
    modelId: "candidate/lfm2-2.6b-onnx",
    profileKey: "k",
    outcome: "load-fail",
    recordedAt: "2026-08-26T21:14:00.000Z",
    ...over,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildFeedbackFailureSummary", () => {
  it("is null when the ledger holds no failures — nothing to attach", () => {
    readAll.mockReturnValue([row({ outcome: "smoke-pass" }), row({ outcome: "generate-pass" })]);
    expect(buildFeedbackFailureSummary()).toBeNull();
  });

  it("renders only failure rows: date, outcome, model, error code, backend", () => {
    readAll.mockReturnValue([
      row({ outcome: "smoke-pass", firstTokenMs: 1200, tokensPerSec: 31 }),
      row({ outcome: "download-fail", modelId: "candidate/qwen3.5-2b-onnx", errorCode: "insufficient-storage", recordedAt: "2026-08-25T08:00:00.000Z" }),
      row({ outcome: "load-fail", backend: "webgpu" }),
    ]);
    expect(buildFeedbackFailureSummary()).toBe(
      "2026-08-26 load-fail candidate/lfm2-2.6b-onnx webgpu\n" +
        "2026-08-25 download-fail candidate/qwen3.5-2b-onnx insufficient-storage",
    );
  });

  it("never includes timings or GPU limits — nothing that fingerprints a machine", () => {
    readAll.mockReturnValue([
      row({ outcome: "generate-fail", firstTokenMs: 999, tokensPerSec: 12.5, durationMs: 4321, gpuLimits: { maxBufferSize: 1, maxStorageBufferBindingSize: 2 } as LedgerEntry["gpuLimits"] }),
    ]);
    const text = buildFeedbackFailureSummary() ?? "";
    expect(text).not.toMatch(/999|12\.5|4321|maxBuffer/);
  });

  it("collapses identical failures into one line with a count, keeping the latest date", () => {
    readAll.mockReturnValue([
      row({ outcome: "download-fail", modelId: "candidate/lfm2.5-350m-onnx", errorCode: "failed", recordedAt: "2026-08-23T10:00:00.000Z" }),
      row({ outcome: "download-fail", modelId: "candidate/lfm2.5-350m-onnx", errorCode: "failed", recordedAt: "2026-08-24T10:00:00.000Z" }),
      row({ outcome: "download-fail", modelId: "candidate/lfm2.5-350m-onnx", errorCode: "failed", recordedAt: "2026-08-24T11:00:00.000Z" }),
      row({ outcome: "load-fail", backend: "webgpu", recordedAt: "2026-08-26T00:00:00.000Z" }),
    ]);
    expect(buildFeedbackFailureSummary()).toBe(
      "2026-08-26 load-fail candidate/lfm2-2.6b-onnx webgpu\n" +
        "2026-08-24 download-fail candidate/lfm2.5-350m-onnx failed ×2\n" +
        "2026-08-23 download-fail candidate/lfm2.5-350m-onnx failed",
    );
  });

  it(`keeps the newest ${MAX_FAILURE_ROWS} failures, newest first`, () => {
    readAll.mockReturnValue(
      Array.from({ length: 8 }, (_, i) =>
        row({ outcome: "load-fail", recordedAt: `2026-08-1${i}T00:00:00.000Z` }),
      ),
    );
    const lines = (buildFeedbackFailureSummary() ?? "").split("\n");
    expect(lines).toHaveLength(MAX_FAILURE_ROWS);
    expect(lines[0]).toMatch(/^2026-08-17/);
    expect(lines[MAX_FAILURE_ROWS - 1]).toMatch(/^2026-08-13/);
  });
});
