// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthPageHref,
  buildChatContinuationHref,
  buildRecoveryPageHref,
  resolveAuthSuccessNavigation,
  resolveAuthSuccessDestination,
  sanitizeRelativeUrl,
  toAbsoluteWebUrl,
} from "../auth-continuation";

describe("auth continuation helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects external callback targets", () => {
    expect(sanitizeRelativeUrl("https://evil.example/phish", "/chat")).toBe("/chat");
    expect(sanitizeRelativeUrl("//evil.example/phish", "/chat")).toBe("/chat");
  });

  it("keeps safe relative callback targets", () => {
    expect(sanitizeRelativeUrl("/chat?tab=settings", "/chat")).toBe("/chat?tab=settings");
  });

  it.each([
    "/api/gate",
    "/api/admin/economy",
    "/admin",
    "/validation/authenticated-ready",
    "/_next/static/chunk.js",
    "/favicon.ico",
  ])("collapses unsafe route-class callback target %s", (callbackUrl) => {
    expect(sanitizeRelativeUrl(callbackUrl, "/chat")).toBe("/chat");
    expect(resolveAuthSuccessDestination(callbackUrl, "Keep this local")).toBe(
      "/chat?prompt=Keep+this+local",
    );
  });

  it("preserves prompt intent when auth returns to chat", () => {
    expect(resolveAuthSuccessDestination("/chat", "Keep this local")).toBe(
      "/chat?prompt=Keep+this+local",
    );
  });

  it("keeps non-chat callbacks unchanged", () => {
    expect(resolveAuthSuccessDestination("/settings", "Keep this local")).toBe("/settings");
  });

  it("can resolve chat-bound prompt handoffs into a promptless redirect plus resumable prompt", () => {
    expect(resolveAuthSuccessNavigation("/chat", "Keep this local")).toEqual({
      redirectTo: "/chat",
      promptToResume: "Keep this local",
    });
  });

  it("keeps non-chat prompt callbacks as normal redirects without local prompt stashing", () => {
    expect(resolveAuthSuccessNavigation("/settings", "Keep this local")).toEqual({
      redirectTo: "/settings",
      promptToResume: null,
    });
  });

  it.each([
    "/download",
    "/founding-miners",
    "/developers",
    "/try",
    "/chat/new",
    // /network and /governance moved to the eco-desktop product; like the other
    // retired surfaces they now collapse back to the canonical chat route rather
    // than being preserved as auth-success destinations.
    "/network",
    "/governance",
  ])(
    "collapses %s callbacks back to the canonical chat route",
    (callbackUrl) => {
      expect(resolveAuthSuccessDestination(callbackUrl, "Keep this local")).toBe(
        "/chat?prompt=Keep+this+local",
      );
    },
  );

  it("builds sign-up and sign-in links with preserved callback and prompt context", () => {
    expect(
      buildAuthPageHref("/sign-up", {
        callbackUrl: "/chat",
        prompt: "Summarize this article",
      }),
    ).toBe("/sign-up?callbackUrl=%2Fchat&prompt=Summarize+this+article");

    expect(
      buildAuthPageHref("/sign-in", {
        callbackUrl: "/chat",
        prompt: "Summarize this article",
      }),
    ).toBe("/sign-in?callbackUrl=%2Fchat&prompt=Summarize+this+article");
  });

  it("collapses unsafe auth entry callbacks while preserving prompt intent", () => {
    expect(
      buildAuthPageHref("/sign-up", {
        callbackUrl: "https://evil.example/phish",
        prompt: "Keep this local",
      }),
    ).toBe("/sign-up?callbackUrl=%2Fchat&prompt=Keep+this+local");

    expect(
      buildAuthPageHref("/sign-in", {
        callbackUrl: "/api/admin/economy",
        prompt: "Keep this local",
      }),
    ).toBe("/sign-in?callbackUrl=%2Fchat&prompt=Keep+this+local");
  });

  it("builds guest local chat links with prompt continuation only when present", () => {
    expect(buildChatContinuationHref("Keep this local")).toBe(
      "/chat?prompt=Keep+this+local",
    );
    expect(buildChatContinuationHref("   ")).toBe("/chat");
  });

  it("builds password recovery links without losing sanitized chat continuation", () => {
    expect(
      buildRecoveryPageHref("/forgot-password", {
        callbackUrl: "/chat",
        prompt: "Keep this local",
      }),
    ).toBe("/forgot-password?callbackUrl=%2Fchat&prompt=Keep+this+local");

    expect(
      buildRecoveryPageHref("/reset-password", {
        callbackUrl: "/api/admin/economy",
        prompt: "Keep this local",
      }),
    ).toBe("/reset-password?callbackUrl=%2Fchat&prompt=Keep+this+local");
  });

  it("resolves emailed-link redirect targets to absolute web-origin URLs", () => {
    // Better Auth resolves relative callback/redirect URLs against the API
    // origin when building emailed links, where no app pages exist — so
    // anything sent as redirectTo/callbackURL must already be absolute.
    expect(toAbsoluteWebUrl("/reset-password?callbackUrl=%2Fchat")).toBe(
      new URL(
        "/reset-password?callbackUrl=%2Fchat",
        window.location.origin,
      ).toString(),
    );
    expect(toAbsoluteWebUrl("/chat")).toBe(`${window.location.origin}/chat`);
  });

});
