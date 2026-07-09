// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it, vi } from "vitest";

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((href: string) => {
    throw new Error(`redirect:${href}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

import ChatNewRedirectPage from "../page";

describe("ChatNewRedirectPage", () => {
  it("recovers stale /chat/new requests into /chat", () => {
    expect(() => ChatNewRedirectPage()).toThrow("redirect:/chat");
    expect(redirectMock).toHaveBeenCalledWith("/chat");
  });
});
