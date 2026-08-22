// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildFeedbackDeviceSummary } from "../feedback-device-summary";

vi.mock("../../local-ai/device/profile", () => ({
  getDeviceProfileSnapshot: vi.fn(() => ({
    browserClass: "firefox",
    webgpuSupport: "webgpu",
    deviceMemoryGB: 8,
    isMobile: false,
    override: "auto",
  })),
}));

vi.mock("../active-model", () => ({
  resolveActiveModelId: vi.fn(() => "candidate/eco-compact"),
}));

import { getDeviceProfileSnapshot } from "../../local-ai/device/profile";
import { resolveActiveModelId } from "../active-model";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildFeedbackDeviceSummary", () => {
  it("composes plain factual values joined by middle dots", () => {
    expect(buildFeedbackDeviceSummary()).toBe(
      "browser: firefox · engine: webgpu · memory: 8 GB · desktop · model: candidate/eco-compact",
    );
  });

  it("says mobile when the profile is mobile", () => {
    vi.mocked(getDeviceProfileSnapshot).mockReturnValueOnce({
      browserClass: "mobile",
      webgpuSupport: "wasm-only",
      deviceMemoryGB: 4,
      isMobile: true,
      override: "auto",
    });

    expect(buildFeedbackDeviceSummary()).toContain("· mobile ·");
  });

  it("degrades to model: unknown when the active model cannot be resolved", () => {
    vi.mocked(resolveActiveModelId).mockImplementationOnce(() => {
      throw new Error("store not hydrated");
    });

    expect(buildFeedbackDeviceSummary()).toContain("model: unknown");
  });

  it("contains no key/value pairs beyond the five documented facts", () => {
    const summary = buildFeedbackDeviceSummary();
    expect(summary.split(" · ")).toHaveLength(5);
  });
});
