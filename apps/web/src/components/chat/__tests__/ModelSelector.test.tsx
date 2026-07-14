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

  it("lists every v1.0 catalog model and no Eco Network option", async () => {
    const user = userEvent.setup();
    render(<ModelSelector variant="composer" />);

    await user.click(screen.getByTestId("model-selector"));

    const listbox = getListbox();
    const options = within(listbox).getAllByRole("option");
    // Exactly the 6 catalog models — one option per catalog entry.
    expect(options).toHaveLength(getCatalog().length);
    expect(options).toHaveLength(6);

    // Branded friendly names are surfaced; no "Eco Network" / network copy.
    expect(within(listbox).getByText("Eco (Qwen)")).toBeInTheDocument();
    expect(within(listbox).queryByText(/eco network/i)).not.toBeInTheDocument();
    expect(within(listbox).queryByText(/coming soon/i)).not.toBeInTheDocument();
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
    render(<ModelSelector variant="composer" />);

    await user.click(screen.getByTestId("model-selector"));

    const listbox = getListbox();
    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(within(listbox).getByText("Eco Capable (Gemma)")).toBeInTheDocument();
    // The f16-only models (e.g. Phi-3) are not offered on this device.
    expect(within(listbox).queryByText("Eco Reasoning (Microsoft)")).not.toBeInTheDocument();
  });

  it("marks the recommended (Qwen3.5) model", async () => {
    const user = userEvent.setup();
    render(<ModelSelector variant="composer" />);

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
    render(<ModelSelector variant="composer" />);

    await user.click(screen.getByTestId("model-selector"));
    await user.click(screen.getByText("Eco Reasoning (Microsoft)"));

    expect(mockSetSelectedModel).toHaveBeenCalledWith(
      "local/phi3-mini-4k-q4f16",
      { explicit: true },
    );
  });

  it("renders the composer trigger as a pill with a label after mount", async () => {
    render(<ModelSelector variant="composer" />);

    const trigger = screen.getByTestId("model-selector");
    expect(trigger).toHaveClass("rounded-full");
    // With selectedModel="auto", the recommended Qwen3.5 name shows.
    expect(trigger).toHaveTextContent("Eco (Qwen)");
  });
});
