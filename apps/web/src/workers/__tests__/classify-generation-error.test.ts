// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { classifyGenerationError } from "../classify-generation-error";

describe("classifyGenerationError", () => {
  it("maps the Dawn buffer-mapping allocation failure to 'oom'", () => {
    expect(
      classifyGenerationError("Failed to allocate memory for buffer mapping"),
    ).toBe("oom");
  });

  it("maps a bare 'Allocation failed' phrasing to 'oom' (case-insensitive)", () => {
    expect(classifyGenerationError("Allocation failed")).toBe("oom");
  });

  it("maps explicit out-of-memory / oom phrasings to 'oom'", () => {
    expect(classifyGenerationError("RuntimeError: out of memory")).toBe("oom");
    expect(classifyGenerationError("WebGPU OOM during decode")).toBe("oom");
  });

  it("maps a device-lost phrasing to 'device-lost'", () => {
    expect(
      classifyGenerationError("The WebGPU device was lost: Device destroyed"),
    ).toBe("device-lost");
  });

  it("falls back to 'generation-failed' for an unknown message", () => {
    // Avoid substrings the conservative matchers key on (e.g. 'oom' inside
    // "boom"). Bare-'oom' matching is intentional — it catches "OOM" phrasings.
    expect(classifyGenerationError("unexpected failure in decode loop")).toBe(
      "generation-failed",
    );
  });

  it("does NOT treat a bare 'buffer mapping' log as OOM", () => {
    expect(classifyGenerationError("buffer mapping pending")).toBe(
      "generation-failed",
    );
  });
});
