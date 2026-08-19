// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ModelSelector } from "../ModelSelector";
import { getCatalog } from "../../../local-ai/catalog/catalog";
import { listCatalog } from "../../../local-ai/index";

let mockIsMobile = false;
vi.mock("../../../hooks/useMediaQuery", () => ({
  useMediaQuery: () => mockIsMobile,
}));

// Keep the recommendation deterministic — Bonsai is the v1.0 default.
vi.mock("../../../local-ai/index", () => ({
  getDeviceProfile: () => ({
    browserClass: "chromium",
    webgpuSupport: "webgpu",
    deviceMemoryGB: 16,
    isMobile: false,
    override: "auto",
  }),
  canServe: () => true,
  recommend: () => ({ id: "candidate/qwen3.5-2b-onnx" }),
  listCatalog: vi.fn(),
}));

let mockSelectedModel = "auto";
const mockSetSelectedModel = vi.fn((model: string) => {
  mockSelectedModel = model;
});

vi.mock("../../../stores/chatStore", () => ({
  useChatStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        selectedModel: mockSelectedModel,
        setSelectedModel: mockSetSelectedModel,
      }),
    {
      getState: () => ({
        selectedModel: mockSelectedModel,
        setSelectedModel: mockSetSelectedModel,
      }),
    },
  ),
}));

function getListbox() {
  return screen.getByRole("listbox", { name: /select model/i });
}

describe("ModelSelector (composer)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile = false;
    mockSelectedModel = "auto";
    localStorage.clear();
    // Default: a capable device runs the whole catalog. Individual tests
    // override this to model a constrained (e.g. f16-less) device.
    vi.mocked(listCatalog).mockReturnValue({
      available: getCatalog().map((model, index) => ({
        model,
        confidence: "calculated" as const,
        scoreTotal: 1000 - index,
      })),
    });
  });

  it("lists one row per runnable AI and no Eco Network option", async () => {
    const user = userEvent.setup();
    render(<ModelSelector />);

    await user.click(screen.getByTestId("model-selector"));

    const listbox = getListbox();
    const options = within(listbox).getAllByRole("option");
    // One row per branded name: 10 catalog entries, but the f16 and int4 builds
    // of the 1.2B are the same "Eco Fast (Liquid)" and collapse into one row.
    expect(options).toHaveLength(getCatalog().length - 1);
    expect(options).toHaveLength(9);

    // Branded friendly names are surfaced; no "Eco Network" / network copy.
    expect(within(listbox).getByText("Eco (Qwen)")).toBeInTheDocument();
    expect(within(listbox).queryByText(/eco network/i)).not.toBeInTheDocument();
    expect(within(listbox).queryByText(/coming soon/i)).not.toBeInTheDocument();
  });

  // Both 1.2B builds brand as "Eco Fast (Liquid)" on purpose — the choice
  // between them is a graphics-hardware detail. A device that can serve both
  // used to see two rows a person could not tell apart.
  it("shows the duplicate-named 1.2B pair as a single row", async () => {
    const f16 = getCatalog().find((m) => m.id === "candidate/lfm2.5-1.2b-instruct-onnx")!;
    const int4 = getCatalog().find((m) => m.id === "candidate/lfm2.5-1.2b-instruct-q4-onnx")!;
    vi.mocked(listCatalog).mockReturnValue({
      available: [f16, int4].map((model, index) => ({
        model,
        confidence: "calculated" as const,
        scoreTotal: 100 - index,
      })),
    });

    const user = userEvent.setup();
    render(<ModelSelector />);

    await user.click(screen.getByTestId("model-selector"));

    const listbox = getListbox();
    expect(within(listbox).getAllByRole("option")).toHaveLength(1);
    expect(within(listbox).getAllByText("Eco Fast (Liquid)")).toHaveLength(1);
  });

  it("keeps the selected build's row when it is the duplicate that would be dropped", async () => {
    mockSelectedModel = "candidate/lfm2.5-1.2b-instruct-q4-onnx";
    const f16 = getCatalog().find((m) => m.id === "candidate/lfm2.5-1.2b-instruct-onnx")!;
    const int4 = getCatalog().find((m) => m.id === "candidate/lfm2.5-1.2b-instruct-q4-onnx")!;
    vi.mocked(listCatalog).mockReturnValue({
      available: [f16, int4].map((model, index) => ({
        model,
        confidence: "calculated" as const,
        scoreTotal: 100 - index,
      })),
    });

    const user = userEvent.setup();
    render(<ModelSelector />);

    await user.click(screen.getByTestId("model-selector"));

    const listbox = getListbox();
    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(1);
    // The surviving row is the selected build, so the checkmark still lands.
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    await user.click(within(listbox).getByText("Eco Fast (Liquid)"));
    expect(mockSetSelectedModel).toHaveBeenCalledWith(
      "candidate/lfm2.5-1.2b-instruct-q4-onnx",
      { explicit: true },
    );
  });

  it("offers only the AIs this device can run (an f16-less device sees no f16 models)", async () => {
    // listCatalog already filters by capability; on a WebGPU adapter without
    // shader-f16 only non-f16 models survive — Gemma 4 (LiteRT) is the default.
    // The selector must surface exactly that set — never a model that would fail
    // to load. (Bonsai, the former non-f16 rung, retired 2026-07-11.)
    const gemma = getCatalog().find((m) => m.id === "candidate/gemma-4-e2b-litert")!;
    vi.mocked(listCatalog).mockReturnValue({
      available: [{ model: gemma, confidence: "calculated", scoreTotal: 100 }],
    });

    const user = userEvent.setup();
    render(<ModelSelector />);

    await user.click(screen.getByTestId("model-selector"));

    const listbox = getListbox();
    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(within(listbox).getByText("Eco Capable (Gemma)")).toBeInTheDocument();
    // The f16 models (e.g. the everyday default) are not offered on this device.
    expect(within(listbox).queryByText("Eco Fast (Liquid)")).not.toBeInTheDocument();
  });

  it("marks the recommended (Qwen3.5) model", async () => {
    const user = userEvent.setup();
    render(<ModelSelector />);

    await user.click(screen.getByTestId("model-selector"));

    const listbox = getListbox();
    const recommendedTag = within(listbox).getByText("Recommended");
    expect(recommendedTag).toBeInTheDocument();
    // The Recommended tag sits on the recommended Qwen3.5 row.
    const qwenRow = within(listbox).getByText("Eco (Qwen)").closest("button");
    expect(qwenRow).toContainElement(recommendedTag);
  });

  it("sets the active model when a row is selected", async () => {
    const user = userEvent.setup();
    render(<ModelSelector />);

    await user.click(screen.getByTestId("model-selector"));
    await user.click(screen.getByText("Eco Compact (Qwen)"));

    expect(mockSetSelectedModel).toHaveBeenCalledWith(
      "local/qwen3-0.6b",
      { explicit: true },
    );
  });

  it("renders the composer trigger as a pill with a label after mount", async () => {
    render(<ModelSelector />);

    const trigger = screen.getByTestId("model-selector");
    expect(trigger).toHaveClass("rounded-full");
    // One identity in the composer: the visible label is always "Eco". The
    // branded model name ("Eco (Qwen)") is demoted to the hover/aria detail —
    // present for transparency, but never chrome the user carries.
    expect(trigger).toHaveTextContent("Eco");
    expect(trigger).not.toHaveTextContent("Qwen");
    expect(trigger).toHaveAttribute("title", "Eco (Qwen)");
  });

  // The selector has one mount, in the composer, pinned to the bottom of the
  // viewport — so the panel is anchored to the trigger's top edge and grows
  // upward. There is no downward case to choose between.
  it("anchors the desktop dropdown above the trigger", async () => {
    const user = userEvent.setup();
    render(<ModelSelector />);

    await user.click(screen.getByTestId("model-selector"));

    const panel = getListbox().parentElement;
    expect(panel).not.toBeNull();
    expect(panel?.style.position).toBe("fixed");
    expect(panel?.style.top).toBe("");
    expect(panel?.style.bottom).not.toBe("");
    expect(panel?.style.transformOrigin).toBe("bottom right");
  });
});
