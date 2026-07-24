// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { MessageActions } from "../MessageActions";

// Mock remark + strip-markdown
vi.mock("remark", () => ({
  remark: () => ({
    use: () => ({
      process: async (content: string) => ({
        toString: () => content.replace(/[*_#`]/g, ""),
      }),
    }),
  }),
}));

vi.mock("strip-markdown", () => ({
  default: {},
}));

describe("MessageActions", () => {
  let writeMock: ReturnType<typeof vi.fn>;
  let writeTextMock: ReturnType<typeof vi.fn>;
  let originalClipboardItem: typeof globalThis.ClipboardItem;

  beforeEach(() => {
    writeMock = vi.fn().mockResolvedValue(undefined);
    writeTextMock = vi.fn().mockResolvedValue(undefined);

    // Save original if it exists
    originalClipboardItem = globalThis.ClipboardItem;

    // Mock ClipboardItem on globalThis (jsdom doesn't include it)
    globalThis.ClipboardItem = vi.fn().mockImplementation((items) => ({
      types: Object.keys(items),
      items,
    })) as unknown as typeof ClipboardItem;

    Object.defineProperty(navigator, "clipboard", {
      value: {
        write: writeMock,
        writeText: writeTextMock,
        readText: vi.fn().mockResolvedValue(""),
        read: vi.fn().mockResolvedValue([]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    globalThis.ClipboardItem = originalClipboardItem;
    vi.restoreAllMocks();
  });

  it("copies plain text via copyTextWithFallback, stripping markdown", async () => {
    render(<MessageActions content="**bold** text" role="assistant" />);
    const copyBtn = screen.getByRole("button", { name: /copy message/i });
    fireEvent.click(copyBtn);

    // The reliable path is writeText (raced + execCommand fallback), not the
    // ClipboardItem blob. The mock strip-markdown drops the markdown chars, so
    // writeText receives the stripped text.
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("bold text");
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /copied/i }),
      ).toBeInTheDocument();
    });
  });

  it("copies markdown verbatim via copyTextWithFallback", async () => {
    render(<MessageActions content="**bold** text" role="assistant" />);

    // Open three-dot menu
    const menuBtn = screen.getByRole("button", { name: /more actions/i });
    fireEvent.click(menuBtn);
    fireEvent.click(screen.getByText("Copy as Markdown"));

    // Copy-as-Markdown copies the source verbatim (no strip-markdown).
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("**bold** text");
    });
  });

  it("copies a canonical exact-answer VERBATIM (plainText) — never strip-markdown, so `*` survives", async () => {
    // The launch-bar regression: a computed value "17 * 23 = 391" run through
    // strip-markdown loses its `*` (remark parses it as emphasis). A canonical
    // answer is already plain text, so `plainText` copies it byte-for-byte.
    render(
      <MessageActions content="17 * 23 = 391" role="assistant" plainText />,
    );
    fireEvent.click(screen.getByRole("button", { name: /copy message/i }));

    // Verbatim: writeText receives exactly the source string, `*` intact.
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("17 * 23 = 391");
    });
  });

  it("without plainText, the same value is routed through strip-markdown (proves the flag matters)", async () => {
    // Contrast case: the default path strips markdown, which the mock renders as
    // dropping `*` — corrupting the value. That corruption is exactly what
    // `plainText` avoids.
    render(<MessageActions content="17 * 23 = 391" role="assistant" />);
    fireEvent.click(screen.getByRole("button", { name: /copy message/i }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalled();
    });
    const copied = writeTextMock.mock.calls[0]![0] as string;
    // The stripped `*` makes the copied text strictly shorter and `*`-free.
    expect(copied.length).toBeLessThan("17 * 23 = 391".length);
    expect(copied).not.toContain("*");
  });

  it("three-dot menu reveals Copy as Markdown option", async () => {
    const user = userEvent.setup();
    render(<MessageActions content="**bold** text" role="assistant" />);
    const menuBtn = screen.getByRole("button", { name: /more actions/i });
    await user.click(menuBtn);
    expect(menuBtn).toHaveAttribute("aria-haspopup", "menu");
    expect(menuBtn).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: /message actions/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy as Markdown" })).toHaveFocus();
  });

  it("shows premium assistant follow-up actions for latest assistant messages", async () => {
    const user = userEvent.setup();
    render(
      <MessageActions
        content="Answer"
        role="assistant"
        isLatestAssistant={true}
        onAssistantAction={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: /more actions/i }));
    expect(screen.getByText("Continue")).toBeInTheDocument();
    expect(screen.getByText("Make shorter")).toBeInTheDocument();
    expect(screen.getByText("Expand")).toBeInTheDocument();
    expect(screen.getByText("Explain simply")).toBeInTheDocument();
  });

  it("calls assistant follow-up action and closes the menu", async () => {
    const user = userEvent.setup();
    const onAssistantAction = vi.fn();
    render(
      <MessageActions
        content="Answer"
        role="assistant"
        isLatestAssistant={true}
        onAssistantAction={onAssistantAction}
      />,
    );
    await user.click(screen.getByRole("button", { name: /more actions/i }));
    await user.click(screen.getByText("Make shorter"));
    expect(onAssistantAction).toHaveBeenCalledWith("shorter");
    expect(screen.queryByText("Make shorter")).not.toBeInTheDocument();
  });

  it("Copy as Markdown shows Copied feedback", async () => {
    render(<MessageActions content="**bold** text" role="assistant" />);
    const menuBtn = screen.getByRole("button", { name: /more actions/i });
    fireEvent.click(menuBtn);
    fireEvent.click(screen.getByText("Copy as Markdown"));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /copied/i }),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("status")).toHaveTextContent("Message copied to clipboard");
  });

  it("closes the menu on Escape and restores focus to the more actions button", async () => {
    const user = userEvent.setup();
    render(<MessageActions content="Answer" role="assistant" />);

    const menuBtn = screen.getByRole("button", { name: /more actions/i });
    await user.click(menuBtn);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(menuBtn).toHaveFocus();
  });

  it("edit button appears for user messages", () => {
    const onEdit = vi.fn();
    render(<MessageActions content="Hello" role="user" onEdit={onEdit} />);
    expect(
      screen.getByRole("button", { name: /edit message/i }),
    ).toBeInTheDocument();
  });

  it("edit button not shown for assistant messages", () => {
    render(<MessageActions content="Response" role="assistant" />);
    expect(
      screen.queryByRole("button", { name: /edit message/i }),
    ).not.toBeInTheDocument();
  });

  it("edit button calls onEdit when clicked", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<MessageActions content="Hello" role="user" onEdit={onEdit} />);
    await user.click(screen.getByRole("button", { name: /edit message/i }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("regenerate button appears only on latest assistant message", () => {
    const onRegenerate = vi.fn();
    render(
      <MessageActions
        content="Response"
        role="assistant"
        isLatestAssistant={true}
        onRegenerate={onRegenerate}
      />,
    );
    expect(
      screen.getByRole("button", { name: /regenerate/i }),
    ).toBeInTheDocument();
  });

  it("regenerate button not shown when not latest assistant", () => {
    render(
      <MessageActions
        content="Response"
        role="assistant"
        isLatestAssistant={false}
        onRegenerate={() => {}}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /regenerate/i }),
    ).not.toBeInTheDocument();
  });

  it("regenerate button calls onRegenerate when clicked", async () => {
    const user = userEvent.setup();
    const onRegenerate = vi.fn();
    render(
      <MessageActions
        content="Response"
        role="assistant"
        isLatestAssistant={true}
        onRegenerate={onRegenerate}
      />,
    );
    await user.click(screen.getByRole("button", { name: /regenerate/i }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("all action buttons have aria-labels", () => {
    render(
      <MessageActions
        content="Response"
        role="assistant"
        isLatestAssistant={true}
        onRegenerate={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /copy message/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /more actions/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /regenerate/i }),
    ).toBeInTheDocument();
  });

  it("does not show a success state when the copy genuinely fails", async () => {
    // writeText rejects (e.g. iOS lost user-activation) AND the execCommand
    // fallback reports failure — copyTextWithFallback rejects, so the button
    // must NOT claim success.
    writeTextMock.mockRejectedValue(new Error("NotAllowed"));
    document.execCommand = vi.fn(() => false);

    render(<MessageActions content="fallback test" role="assistant" plainText />);
    const copyBtn = screen.getByRole("button", { name: /copy message/i });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("fallback test");
    });
    // Truthful feedback: no "Copied" state after a real failure.
    expect(
      screen.queryByRole("button", { name: /copied/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /copy message/i }),
    ).toBeInTheDocument();
  });
});

describe("MessageActions — flag for eval (dev capture)", () => {
  it("shows the flag item for assistant messages when the handler is provided", async () => {
    const onFlagForEval = vi.fn();
    render(
      <MessageActions content="hi" role="assistant" onFlagForEval={onFlagForEval} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    const item = await screen.findByRole("menuitem", { name: /flag for eval/i });
    fireEvent.click(item);

    expect(onFlagForEval).toHaveBeenCalledTimes(1);
    // Menu closes after flagging.
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  it("hides the flag item when no handler is provided", () => {
    render(<MessageActions content="hi" role="assistant" />);
    fireEvent.click(screen.getByRole("button", { name: /more actions/i }));
    expect(screen.queryByRole("menuitem", { name: /flag for eval/i })).not.toBeInTheDocument();
  });
});
