// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks — stub heavy child components to keep tests fast and focused
// ---------------------------------------------------------------------------

vi.mock("../../components/chat/MarkdownRenderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

vi.mock("../../components/chat/StreamingCursor", () => ({
  StreamingCursor: () => <span data-testid="streaming-cursor" />,
}));

vi.mock("../../components/chat/TokenRate", () => ({
  TokenRate: () => null,
}));

vi.mock("../../components/chat/MessageActions", () => ({
  MessageActions: () => null,
}));

vi.mock("../../components/chat/MessageReactions", () => ({
  MessageReactions: () => null,
}));

vi.mock("../../components/chat/ErrorMessage", () => ({
  ErrorMessage: () => null,
}));

vi.mock("../../components/chat/StreamInterrupted", () => ({
  StreamInterrupted: () => null,
}));

vi.mock("../../components/chat/BranchNavigation", () => ({
  BranchNavigation: () => null,
}));

vi.mock("../../components/chat/EditMessage", () => ({
  EditMessage: () => null,
}));

vi.mock("../../components/chat/FileBlock", () => ({
  FileBlock: () => null,
  parseFileBlocks: () => null,
}));

vi.mock("../../components/chat/ToolCallBlock", () => ({
  ToolCallBlock: () => null,
}));

vi.mock("../../components/chat/LocalConfidenceCTA", () => ({
  LocalConfidenceCTA: () => null,
}));

vi.mock("../../components/chat/OfflineDivider", () => ({
  OfflineDivider: () => null,
}));

vi.mock("../../components/EcoLogo", () => ({
  EcoLogo: () => <span data-testid="eco-logo" />,
}));

vi.mock("../../stores/settingsStore", () => ({
  useSettingsStore: () => false,
}));

import { MessageBubble } from "../../components/chat/MessageBubble";

// ---------------------------------------------------------------------------
// Tests: persistent metadata stays minimal in the polished chat surface
// ---------------------------------------------------------------------------

describe("MessageBubble — minimal persistent metadata", () => {
  it("does not render a persistent On-Device badge for completed local assistant messages", () => {
    render(
      <MessageBubble
        role="assistant"
        content="Hello from your device!"
        inferenceMethod="local"
        isStreaming={false}
        status="complete"
      />
    );

    expect(screen.queryByText("On-Device")).toBeNull();
  });

  it("does NOT render persistent runtime labels when isStreaming is true", () => {
    render(
      <MessageBubble
        role="assistant"
        content="Generating..."
        inferenceMethod="local"
        isStreaming={true}
      />
    );

    expect(screen.queryByText("On-Device")).toBeNull();
  });

  it("does NOT render persistent runtime labels when inferenceMethod is 'remote'", () => {
    render(
      <MessageBubble
        role="assistant"
        content="Network response"
        inferenceMethod="remote"
        isStreaming={false}
        status="complete"
      />
    );

    expect(screen.queryByText("On-Device")).toBeNull();
  });

  it("does NOT render persistent runtime labels for user messages", () => {
    render(
      <MessageBubble
        role="user"
        content="User typed this"
        inferenceMethod="local"
        isStreaming={false}
      />
    );

    expect(screen.queryByText("On-Device")).toBeNull();
  });

  it("does NOT render persistent runtime labels when inferenceMethod is undefined", () => {
    render(
      <MessageBubble
        role="assistant"
        content="No inference method set"
        isStreaming={false}
        status="complete"
      />
    );

    expect(screen.queryByText("On-Device")).toBeNull();
  });

  it("does not render auto model tags under completed assistant replies", () => {
    render(
      <MessageBubble
        role="assistant"
        content="Accessible message"
        resolvedModel="llama-3.1-8b-q4_k_m"
        isStreaming={false}
        status="complete"
      />
    );

    expect(screen.queryByText(/^Auto$/)).toBeNull();
  });

  it("does NOT render persistent runtime labels for hybrid network-to-local replies", () => {
    render(
      <MessageBubble
        role="assistant"
        content="Recovered locally after a network drop"
        inferenceMethod="local"
        offlineDivider={true}
        isStreaming={false}
        status="complete"
      />
    );

    expect(screen.queryByText("On-Device")).toBeNull();
  });
});
