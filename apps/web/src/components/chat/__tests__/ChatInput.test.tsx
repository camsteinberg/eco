// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChatInput } from "../ChatInput";
import { useChatStore } from "../../../stores/chatStore";

const fileChipMock = vi.hoisted(() => vi.fn());

vi.mock("../FileChip", () => ({
  FileChip: (props: {
    filename: string;
    status: string;
    errorMessage?: string;
    onRemove: () => void;
  }) => {
    fileChipMock(props);
    return (
      <div data-testid="file-chip">
        <span>{props.filename}</span>
        <span>{props.status}</span>
        {props.errorMessage ? <span>{props.errorMessage}</span> : null}
        <button type="button" onClick={props.onRemove}>
          Remove {props.filename}
        </button>
      </div>
    );
  },
}));

vi.mock("../../easter-eggs/LeafAnimation", () => ({
  LeafAnimation: () => null,
  checkEasterEgg: () => null,
}));

// Stub the composer controls — their internals (portals, media queries,
// catalog reads) are exercised by their own suites. Here we only assert that
// ChatInput renders them in the composer row.
vi.mock("../ModelSelector", () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));

vi.mock("../ResearchToggle", () => ({
  ResearchToggle: () => (
    <button type="button" data-testid="research-toggle" disabled aria-disabled="true">
      Research off
    </button>
  ),
}));

describe("ChatInput", () => {
  beforeEach(() => {
    useChatStore.setState({
      composerDraft: "",
      fileAttachments: [],
      selectedModel: "auto",
    });
    fileChipMock.mockReset();
  });

  it("renders the restored composer draft from the shared chat store", () => {
    useChatStore.getState().setComposerDraft("Keep this local");

    render(<ChatInput onSubmit={vi.fn()} />);

    expect(screen.getByLabelText("Message input")).toHaveValue("Keep this local");
  });

  it("submits and clears the restored composer draft", () => {
    const onSubmit = vi.fn();
    useChatStore.getState().setComposerDraft("Resume this message");

    render(<ChatInput onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSubmit).toHaveBeenCalledWith("Resume this message");
    expect(useChatStore.getState().composerDraft).toBe("");
  });

  it("disables send while attachments are still extracting", () => {
    useChatStore.setState({
      composerDraft: "Wait for the file",
      fileAttachments: [
        {
          id: "file-1",
          file: new File(["notes"], "notes.txt", { type: "text/plain" }),
          status: "extracting",
        },
      ],
    });

    render(<ChatInput onSubmit={vi.fn()} />);

    expect(screen.getByRole("button", { name: /preparing attachment/i })).toBeDisabled();
    expect(
      screen.getByText("Preparing attachment… Send unlocks as soon as the text is ready."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send message/i })).not.toBeInTheDocument();
  });

  it("shows a stop control instead of send during the first active generation", () => {
    render(
      <ChatInput
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        isStreaming
        disabled
      />
    );

    expect(screen.getByRole("button", { name: /stop generating/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send message/i })).not.toBeInTheDocument();
  });

  it("renders the inline research pill and composer model selector in the input row", () => {
    const { container } = render(<ChatInput onSubmit={vi.fn()} />);
    const inputRow = container.querySelector("form > div");
    const messageInput = screen.getByLabelText("Message input");

    // The old composer controls are back: a disabled "coming soon" research
    // pill and the model selector, whose only mount this is.
    const researchToggle = screen.getByTestId("research-toggle");
    const modelSelector = screen.getByTestId("model-selector");
    expect(researchToggle).toBeInTheDocument();
    expect(researchToggle).toBeDisabled();
    expect(modelSelector).toBeInTheDocument();

    // Privacy-tier selection stays gone — every turn is on-device in v1.0.
    expect(screen.queryByTestId("privacy-tier-selector")).not.toBeInTheDocument();
    expect(inputRow).toHaveClass("flex", "items-center", "gap-3", "px-4", "py-3");
    expect(inputRow).not.toHaveClass("flex-col");
    expect(messageInput).toHaveClass("min-h-[44px]", "min-w-0", "flex-1", "sm:min-h-0");
  });

  it("renders an attachment chip without a runtime prop (every turn is on-device in v1.0)", () => {
    useChatStore.setState({
      selectedModel: "auto",
      fileAttachments: [
        {
          id: "file-1",
          file: new File(["notes"], "notes.txt", { type: "text/plain" }),
          status: "done",
          result: {
            filename: "notes.txt",
            size: 5,
            content: "notes",
            type: "text",
            truncated: false,
          },
        },
      ],
    });

    render(<ChatInput onSubmit={vi.fn()} />);

    expect(screen.getByTestId("file-chip")).toHaveTextContent("notes.txt");
    // The vestigial runtime prop is gone — the chip no longer branches on it.
    expect(fileChipMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ runtime: expect.anything() }),
    );
  });

  it("prepares accepted attachments locally, allows removal, and does not submit before an explicit send", async () => {
    const onSubmitWithFiles = vi.fn();
    const file = new File(["hello from a local file"], "notes.txt", {
      type: "text/plain",
    });

    const { container } = render(
      <ChatInput onSubmit={vi.fn()} onSubmitWithFiles={onSubmitWithFiles} />,
    );

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();

    fireEvent.change(fileInput!, { target: { files: [file] } });

    expect(onSubmitWithFiles).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId("file-chip")).toHaveTextContent("done");
    });
    expect(onSubmitWithFiles).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /remove notes\.txt/i }));
    expect(screen.queryByTestId("file-chip")).not.toBeInTheDocument();
    expect(onSubmitWithFiles).not.toHaveBeenCalled();
  });

  it("submits extracted attachment content only after the user sends", async () => {
    const onSubmitWithFiles = vi.fn();
    const file = new File(["draft attachment"], "draft.md", {
      type: "text/markdown",
    });

    const { container } = render(
      <ChatInput onSubmit={vi.fn()} onSubmitWithFiles={onSubmitWithFiles} />,
    );

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(fileInput!, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByTestId("file-chip")).toHaveTextContent("done");
    });

    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(onSubmitWithFiles).toHaveBeenCalledWith("", [
      expect.objectContaining({
        filename: "draft.md",
        content: "draft attachment",
        type: "text",
      }),
    ]);
  });

  it("rejects unsupported attachments at selection without creating chips or uploading", async () => {
    const onSubmit = vi.fn();
    const file = new File(["binary"], "malware.exe", {
      type: "application/octet-stream",
    });

    const { container } = render(<ChatInput onSubmit={onSubmit} />);

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(fileInput!, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Eco can't use malware.exe — Unsupported file type (.exe). Try a different file.",
      );
    });
    expect(screen.queryByTestId("file-chip")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send message/i })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("rejects oversized attachments with an accessible error and no chip", async () => {
    const onSubmit = vi.fn();
    const file = new File(["tiny body"], "large-notes.txt", {
      type: "text/plain",
    });
    Object.defineProperty(file, "size", { value: 10 * 1024 * 1024 + 1 });

    const { container } = render(<ChatInput onSubmit={onSubmit} />);

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(fileInput!, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Eco can't use large-notes.txt — Too large (max 10MB). Try a different file.",
      );
    });
    expect(screen.queryByTestId("file-chip")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send message/i })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("surfaces extraction failures accessibly and keeps send disabled", async () => {
    const onSubmit = vi.fn();
    const file = new File(["unreadable"], "broken.txt", {
      type: "text/plain",
    });
    Object.defineProperty(file, "text", {
      value: vi.fn().mockRejectedValue(new Error("The browser could not read this file")),
    });

    const { container } = render(<ChatInput onSubmit={onSubmit} />);

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(fileInput!, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Eco couldn't read broken.txt. Remove it or try a different file.",
      );
    });
    expect(screen.getByTestId("file-chip")).toHaveTextContent("error");
    expect(screen.getByTestId("file-chip")).toHaveTextContent("The browser could not read this file");
    expect(screen.queryByRole("button", { name: /send message/i })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  describe("submit guard", () => {
    it("rejects a second submit within 300ms", () => {
      const onSubmit = vi.fn();
      useChatStore.getState().setComposerDraft("Hello");

      render(<ChatInput onSubmit={onSubmit} />);

      // First submit
      fireEvent.click(screen.getByRole("button", { name: /send message/i }));
      expect(onSubmit).toHaveBeenCalledTimes(1);

      // Rapidly set a new draft and try again (<300ms)
      useChatStore.getState().setComposerDraft("Again");
      fireEvent.click(screen.getByRole("button", { name: /send message/i }));
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("rejects submit while isStreaming is true", () => {
      const onSubmit = vi.fn();
      useChatStore.setState({
        composerDraft: "Hello",
        isStreaming: true,
        streamPhase: "generating",
      });

      const { container } = render(<ChatInput onSubmit={onSubmit} />);

      // The send button isn't shown during streaming (stop is shown),
      // but the form submit handler should still guard.
      const form = container.querySelector("form")!;
      fireEvent.submit(form);
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });
});
