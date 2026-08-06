// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { replaceMock, startNewChatMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  startNewChatMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("../../../../../src/lib/start-new-chat", () => ({
  startNewChat: startNewChatMock,
}));

import ChatNewPage from "../page";

describe("ChatNewPage", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    startNewChatMock.mockReset();
  });

  it("starts a fresh conversation, then lands on /chat", async () => {
    render(<ChatNewPage />);

    await waitFor(() => {
      expect(startNewChatMock).toHaveBeenCalledTimes(1);
      expect(replaceMock).toHaveBeenCalledWith("/chat");
    });

    // The fresh start must land before /chat mounts — the restore effects
    // there reopen whatever localStorage still calls the active conversation.
    expect(startNewChatMock.mock.invocationCallOrder[0]).toBeLessThan(
      replaceMock.mock.invocationCallOrder[0]!,
    );
  });
});
