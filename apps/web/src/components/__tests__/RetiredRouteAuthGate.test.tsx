// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetiredRouteAuthGate } from "../public/RetiredRouteAuthGate";

const { useSessionMock } = vi.hoisted(() => ({
  useSessionMock: vi.fn(),
}));

const originalLocation = window.location;

vi.mock("../../lib/auth", () => ({
  useSession: useSessionMock,
}));

describe("RetiredRouteAuthGate", () => {
  beforeEach(() => {
    useSessionMock.mockReset();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...originalLocation,
        replace: vi.fn(),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("stays idle for signed-out visitors", () => {
    useSessionMock.mockReturnValue({ data: null, isPending: false });

    render(<RetiredRouteAuthGate />);

    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it("redirects authenticated visitors back to chat", async () => {
    useSessionMock.mockReturnValue({
      data: { user: { id: "user-1" } },
      isPending: false,
    });

    render(<RetiredRouteAuthGate />);

    await waitFor(() => {
      expect(window.location.replace).toHaveBeenCalledWith("/chat");
    });
  });
});
