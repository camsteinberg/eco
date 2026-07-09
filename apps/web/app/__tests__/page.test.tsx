// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it, vi } from "vitest";

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((href: string) => {
    throw new Error(`redirect:${href}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

describe("HomePage", () => {
  beforeEach(() => {
    redirectMock.mockClear();
  });

  it("redirects the root route directly to canonical chat", async () => {
    const mod = await import("../page");

    await expect(
      mod.default({
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("redirect:/chat");

    expect(redirectMock).toHaveBeenCalledWith("/chat");
  });

  it("preserves prompt handoff when redirecting to chat", async () => {
    const mod = await import("../page");

    await expect(
      mod.default({
        searchParams: Promise.resolve({
          prompt: "Keep this local",
        }),
      }),
    ).rejects.toThrow("redirect:/chat?prompt=Keep+this+local");

    expect(redirectMock).toHaveBeenCalledWith("/chat?prompt=Keep+this+local");
  });

  it("preserves duplicate prompt values and strips retired preview mode", async () => {
    const mod = await import("../page");

    await expect(
      mod.default({
        searchParams: Promise.resolve({
          prompt: ["Use this prompt", "Keep this alternate"],
          preview: "1",
        }),
      }),
    ).rejects.toThrow(
      "redirect:/chat?prompt=Use+this+prompt&prompt=Keep+this+alternate",
    );

    expect(redirectMock).toHaveBeenCalledWith(
      "/chat?prompt=Use+this+prompt&prompt=Keep+this+alternate",
    );
  });
});
