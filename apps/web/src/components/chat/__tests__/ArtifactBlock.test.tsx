// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

// Mock next/dynamic to load components synchronously in tests.
// next/dynamic is a Next.js runtime feature; in vitest/jsdom we replace it
// with a thin wrapper that eagerly resolves the import factory so tests
// don't have to await the lazy chunk.
vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: (loader: () => Promise<any>, _opts?: Record<string, unknown>) => {
    let Resolved: React.ComponentType<any> | null = null;
    // Kick off the import immediately; because the imported module is already
    // vi.mock-ed above, the promise resolves in the same microtask queue.
    loader().then((mod: { default: React.ComponentType }) => {
      Resolved = mod.default;
    });
    // Return a wrapper component that defers to the resolved component.
    // The first render may miss if the microtask hasn't flushed, so tests
    // that render via MarkdownRenderer use `waitFor` below.
    return (props: any) => (Resolved ? <Resolved {...props} /> : null);
  },
}));

// Mock @codesandbox/sandpack-react since Sandpack requires browser APIs
// not available in Vitest/jsdom
vi.mock("@codesandbox/sandpack-react", () => ({
  SandpackProvider: ({
    children,
    template,
    files,
  }: {
    children: React.ReactNode;
    template: string;
    files: Record<string, string>;
    key?: number;
  }) => (
    <div
      data-testid="sandpack-provider"
      data-template={template}
      data-files={JSON.stringify(files)}
    >
      {children}
    </div>
  ),
  SandpackCodeEditor: ({ style }: { style?: React.CSSProperties }) => (
    <div data-testid="sandpack-code-editor" style={style}>
      Code Editor
    </div>
  ),
  SandpackPreview: ({
    style,
  }: {
    style?: React.CSSProperties;
    showOpenInCodeSandbox?: boolean;
    showRefreshButton?: boolean;
  }) => (
    <div data-testid="sandpack-preview" style={style}>
      Preview
    </div>
  ),
}));

import { MarkdownRenderer } from "../MarkdownRenderer";
import { ArtifactBlock } from "../ArtifactBlock";
import { ArtifactFullscreen } from "../ArtifactFullscreen";

describe("MarkdownRenderer - artifact detection", () => {
  it("renders ArtifactBlock for artifact:react code fence without auto-mounting Sandpack", async () => {
    const md = '```artifact:react\nexport default function App() { return <h1>Hello</h1>; }\n```';
    render(<MarkdownRenderer content={md} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run code/i })).toBeInTheDocument();
    });
    expect(screen.queryByTestId("sandpack-provider")).not.toBeInTheDocument();
  });

  it("mounts Sandpack for artifact:react only after explicit Run", async () => {
    const user = userEvent.setup();
    const md = '```artifact:react\nexport default function App() { return <h1>Hello</h1>; }\n```';
    render(<MarkdownRenderer content={md} />);
    await user.click(await screen.findByRole("button", { name: /run code/i }));
    const provider = await screen.findByTestId("sandpack-provider");
    expect(provider).toHaveAttribute("data-template", "react");
  });

  it("renders ArtifactBlock with type=html for artifact:html code fence without auto-mounting Sandpack", async () => {
    const md = '```artifact:html\n<html><body><h1>Hello</h1></body></html>\n```';
    render(<MarkdownRenderer content={md} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run code/i })).toBeInTheDocument();
    });
    expect(screen.queryByTestId("sandpack-provider")).not.toBeInTheDocument();
  });

  it("mounts Sandpack for artifact:html only after explicit Preview", async () => {
    const user = userEvent.setup();
    const md = '```artifact:html\n<html><body><h1>Hello</h1></body></html>\n```';
    render(<MarkdownRenderer content={md} />);
    await user.click(await screen.findByRole("button", { name: /preview tab/i }));
    const provider = screen.getByTestId("sandpack-provider");
    expect(provider).toHaveAttribute("data-template", "vanilla");
  });

  it("renders CodeBlock for regular javascript code fence (not ArtifactBlock)", () => {
    const md = '```javascript\nconsole.log("hi")\n```';
    render(<MarkdownRenderer content={md} />);
    // Regular CodeBlock renders language label and copy button
    expect(screen.getByText("javascript")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
    // Should NOT have sandpack-provider
    expect(screen.queryByTestId("sandpack-provider")).not.toBeInTheDocument();
  });

  it("renders inline code as inline code element (unchanged)", () => {
    render(<MarkdownRenderer content="Use `console.log` here" />);
    const code = screen.getByText("console.log");
    expect(code.tagName).toBe("CODE");
    // Should NOT have sandpack-provider
    expect(screen.queryByTestId("sandpack-provider")).not.toBeInTheDocument();
  });
});

describe("ArtifactBlock", () => {
  const writeTextMock = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeTextMock.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });
  });

  it("renders inert code by default without mounting Sandpack runtime", () => {
    render(<ArtifactBlock code="<h1>Hello</h1>" type="html" />);
    expect(screen.getByText("<h1>Hello</h1>")).toBeInTheDocument();
    expect(screen.queryByTestId("sandpack-provider")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sandpack-preview")).not.toBeInTheDocument();
  });

  it("switches to Preview tab and mounts Sandpack when clicked", async () => {
    const user = userEvent.setup();
    render(<ArtifactBlock code="<h1>Hello</h1>" type="html" />);
    const previewTab = screen.getByRole("button", { name: /preview tab/i });
    await user.click(previewTab);
    expect(screen.getByTestId("sandpack-preview")).toBeInTheDocument();
  });

  it("unmounts Sandpack runtime when leaving preview", async () => {
    const user = userEvent.setup();
    render(<ArtifactBlock code="<h1>Hello</h1>" type="html" />);
    await user.click(screen.getByRole("button", { name: /preview tab/i }));
    expect(screen.getByTestId("sandpack-provider")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /code tab/i }));
    expect(screen.queryByTestId("sandpack-provider")).not.toBeInTheDocument();
    expect(screen.getByText("<h1>Hello</h1>")).toBeInTheDocument();
  });

  it("Run button switches to Preview tab", async () => {
    const user = userEvent.setup();
    render(<ArtifactBlock code="<h1>Hello</h1>" type="html" />);

    const runBtn = screen.getByRole("button", { name: /run code/i });
    await user.click(runBtn);

    expect(screen.getByTestId("sandpack-preview")).toBeInTheDocument();
  });

  it("Full Screen button opens ArtifactFullscreen modal without auto-running preview", async () => {
    const user = userEvent.setup();
    render(<ArtifactBlock code="<h1>Hello</h1>" type="html" />);
    const fullscreenBtn = screen.getByRole("button", { name: /full screen/i });
    await user.click(fullscreenBtn);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("sandpack-provider")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sandpack-preview")).not.toBeInTheDocument();
  });

  it("Copy button copies code to clipboard", async () => {
    render(<ArtifactBlock code="const x = 42" type="react" />);
    const copyBtn = screen.getByRole("button", { name: /copy code/i });
    await act(async () => {
      copyBtn.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("const x = 42");
    });
  });
});

describe("ArtifactFullscreen", () => {
  it("renders overlay with inert code and no preview runtime", () => {
    render(
      <ArtifactFullscreen code="<h1>Hi</h1>" type="html" onClose={vi.fn()} />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("<h1>Hi</h1>")).toBeInTheDocument();
    expect(screen.queryByTestId("sandpack-provider")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sandpack-preview")).not.toBeInTheDocument();
  });

  it("mounts preview in fullscreen only after explicit Run", async () => {
    const user = userEvent.setup();
    render(
      <ArtifactFullscreen code="<h1>Hi</h1>" type="html" onClose={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /run code/i }));
    expect(screen.getByTestId("sandpack-provider")).toBeInTheDocument();
    expect(screen.getByTestId("sandpack-preview")).toBeInTheDocument();
  });

  it("unmounts fullscreen preview when returning to code", async () => {
    const user = userEvent.setup();
    render(
      <ArtifactFullscreen code="<h1>Hi</h1>" type="html" onClose={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /preview tab/i }));
    expect(screen.getByTestId("sandpack-provider")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /code tab/i }));
    expect(screen.queryByTestId("sandpack-provider")).not.toBeInTheDocument();
  });

  it("close button calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ArtifactFullscreen code="<h1>Hi</h1>" type="html" onClose={onClose} />,
    );
    const closeBtn = screen.getByRole("button", { name: /close fullscreen/i });
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape key closes fullscreen", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ArtifactFullscreen code="<h1>Hi</h1>" type="html" onClose={onClose} />,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("backdrop click closes fullscreen", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ArtifactFullscreen code="<h1>Hi</h1>" type="html" onClose={onClose} />,
    );
    // Click the backdrop (the outermost dialog div)
    const backdrop = screen.getByRole("dialog");
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows correct type label", () => {
    render(
      <ArtifactFullscreen
        code="function App() { return <div>Hi</div>; }"
        type="react"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("React Artifact")).toBeInTheDocument();
  });
});
