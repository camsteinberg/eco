// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The composer selector offers the DEVICE PAIR, not the catalog.
 *
 * Two things this net exists to hold, neither of which the old flat-list tests
 * covered at all:
 *   - download state is visible (the old list offered gigabytes of undownloaded
 *     models as if they were a click away), and
 *   - selection writes a SLOT NAME, never a concrete model id — a store
 *     selection no slot owns is the exact state that let an undownloaded model
 *     reach the runtime, which then self-fetched it mid-turn.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ModelSelector } from "../ModelSelector";
import { getModel } from "../../../local-ai/catalog/catalog";
import { deriveFirstRunChoices } from "../../../local-ai/selection/first-run-choices";
import { isModelDownloaded } from "../../../local-ai/download/download";
import type { ModelConfig, Slot } from "../../../local-ai/types";
import type { SlotState } from "../../../local-ai/lifecycle/slots";

const FAST_ID = "candidate/lfm2.5-1.2b-instruct-onnx";
const DEEP_ID = "candidate/lfm2-2.6b-onnx";
const OUTSIDE_PAIR_ID = "local/qwen3-0.6b";

let mockIsMobile = false;
vi.mock("../../../hooks/useMediaQuery", () => ({
  useMediaQuery: () => mockIsMobile,
}));

const mockProfile = {
  browserClass: "chromium",
  webgpuSupport: "webgpu",
  deviceMemoryGB: 16,
  isMobile: false,
  override: "auto",
};

vi.mock("../../../hooks/local-ai/useDeviceProfile", () => ({
  useDeviceProfile: () => mockProfile,
}));

vi.mock("../../../local-ai/index", () => ({
  canServe: () => true,
}));

// The pair is the unit under test's SOURCE — mocked so the offer is explicit in
// each test rather than a side effect of the recommendation engine.
vi.mock("../../../local-ai/selection/first-run-choices", () => ({
  deriveFirstRunChoices: vi.fn(),
}));

vi.mock("../../../local-ai/download/download", () => ({
  isModelDownloaded: vi.fn(async () => false),
}));

// Slot bindings drive both the "Downloaded" state line and what selection
// writes, so they are per-test state rather than a fixed fixture.
let mockSlots: Record<Slot, { modelId: string | null; status: SlotState["status"] }> = {
  "eco-fast": { modelId: null, status: "empty" },
  "eco-smart": { modelId: null, status: "empty" },
};

// Partial mock: the upgrade/switch machinery in the same import graph needs the
// module's real write surface, only the two reads are steered here.
vi.mock("../../../local-ai/lifecycle/slots", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../local-ai/lifecycle/slots")>()),
  getSlot: (slot: Slot): SlotState => {
    const entry = mockSlots[slot];
    return {
      slot,
      modelId: entry.modelId,
      model: entry.modelId
        ? ({ id: entry.modelId, friendlyName: entry.modelId } as unknown as SlotState["model"])
        : null,
      status: entry.status,
    };
  },
  getSlotForModel: (modelId: string): Slot | null => {
    if (mockSlots["eco-fast"].modelId === modelId) return "eco-fast";
    if (mockSlots["eco-smart"].modelId === modelId) return "eco-smart";
    return null;
  },
}));

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
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

// ─── Helpers ───────────────────────────────────────────────────────────────

function catalogModel(id: string): ModelConfig {
  const model = getModel(id);
  if (!model) throw new Error(`fixture id left the catalog: ${id}`);
  return model;
}

function offerPair(): void {
  vi.mocked(deriveFirstRunChoices).mockReturnValue({
    models: [catalogModel(FAST_ID), catalogModel(DEEP_ID)],
    recommendedId: FAST_ID,
  });
}

function offerSingle(): void {
  vi.mocked(deriveFirstRunChoices).mockReturnValue({
    models: [catalogModel(FAST_ID)],
    recommendedId: FAST_ID,
  });
}

function bindSlot(slot: Slot, modelId: string, status: SlotState["status"] = "ready"): void {
  mockSlots[slot] = { modelId, status };
}

function getListbox() {
  return screen.getByRole("listbox", { name: /select model/i });
}

function tiles() {
  return within(getListbox()).getAllByRole("option");
}

function tileNamed(name: string): HTMLElement {
  const tile = within(getListbox()).getByText(name).closest("button");
  if (!tile) throw new Error(`no tile named ${name}`);
  return tile;
}

async function openSelector(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<ModelSelector />);
  await user.click(screen.getByTestId("model-selector"));
  // The download probe is async; wait for the state line to settle so tests
  // never assert against the pre-probe default.
  await waitFor(() => {
    expect(within(getListbox()).getAllByRole("option").length).toBeGreaterThan(0);
  });
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsMobile = false;
  mockSelectedModel = "auto";
  mockSlots = {
    "eco-fast": { modelId: null, status: "empty" },
    "eco-smart": { modelId: null, status: "empty" },
  };
  vi.mocked(isModelDownloaded).mockResolvedValue(false);
  offerPair();
  localStorage.clear();
});

// ═══════════════════════════════════════════════════════════════════════════

describe("ModelSelector — the offer is the device pair", () => {
  it("renders one tile per model in the device pair, not the catalog", async () => {
    await openSelector();

    expect(tiles()).toHaveLength(2);
    expect(within(getListbox()).getByText("Eco Fast")).toBeInTheDocument();
    expect(within(getListbox()).getByText("Eco Deeper")).toBeInTheDocument();
    // Catalog models outside the pair are not offered.
    expect(within(getListbox()).queryByText(/gemma/i)).not.toBeInTheDocument();
    expect(within(getListbox()).queryByText(/eco network/i)).not.toBeInTheDocument();
  });

  it("sources the offer from deriveFirstRunChoices for the fast slot", async () => {
    await openSelector();

    expect(deriveFirstRunChoices).toHaveBeenCalledWith("eco-fast", mockProfile);
  });

  it("carries each tile's plain-language facts: tagline and Speed/Depth meters", async () => {
    await openSelector();

    const fast = tileNamed("Eco Fast");
    expect(within(fast).getByText(/good for everyday questions/i)).toBeInTheDocument();
    expect(within(fast).getByLabelText("Speed: 4 of 4")).toBeInTheDocument();
    expect(within(fast).getByLabelText("Depth: 2 of 4")).toBeInTheDocument();
  });

  it("keeps the full-catalog surface one tap away", async () => {
    await openSelector();

    expect(within(getListbox()).getByRole("link", { name: /switch your ai/i })).toHaveAttribute(
      "href",
      "/settings?tab=models",
    );
  });
});

describe("ModelSelector — download state is visible", () => {
  it("shows a model's download size when its bytes are not here", async () => {
    await openSelector();

    const deeper = tileNamed("Eco Deeper");
    expect(within(deeper).getByText("~1.7 GB")).toBeInTheDocument();
    expect(within(deeper).getByText("Not downloaded")).toBeInTheDocument();
  });

  it("shows 'Downloaded' when the bytes are present", async () => {
    vi.mocked(isModelDownloaded).mockImplementation(async (model: ModelConfig) =>
      model.id === DEEP_ID,
    );

    await openSelector();

    await waitFor(() => {
      expect(within(tileNamed("Eco Deeper")).getByText("Downloaded")).toBeInTheDocument();
    });
    expect(within(tileNamed("Eco Fast")).getByText("Not downloaded")).toBeInTheDocument();
  });

  it("shows 'Downloaded' for a model whose slot is ready, without a byte probe verdict", async () => {
    bindSlot("eco-fast", FAST_ID, "ready");

    await openSelector();

    expect(within(tileNamed("Eco Fast")).getByText("Downloaded")).toBeInTheDocument();
  });

  it("does not call a preparing slot's model downloaded", async () => {
    bindSlot("eco-fast", FAST_ID, "preparing");

    await openSelector();

    expect(within(tileNamed("Eco Fast")).getByText("Not downloaded")).toBeInTheDocument();
  });
});

describe("ModelSelector — selection writes slot names, never concrete ids", () => {
  it("binds the SLOT that owns a downloaded model", async () => {
    bindSlot("eco-smart", DEEP_ID, "ready");
    mockSelectedModel = "eco-fast";
    bindSlot("eco-fast", FAST_ID, "ready");

    const user = await openSelector();
    await user.click(tileNamed("Eco Deeper"));

    expect(mockSetSelectedModel).toHaveBeenCalledWith("eco-smart", { explicit: true });
    // Never the concrete id — that is the unbound-selection state itself.
    for (const call of mockSetSelectedModel.mock.calls) {
      expect(["eco-fast", "eco-smart"]).toContain(call[0]);
    }
  });

  it("routes an undownloaded model to the Settings download flow, preselected", async () => {
    bindSlot("eco-fast", FAST_ID, "ready");
    mockSelectedModel = "eco-fast";

    const user = await openSelector();
    await user.click(tileNamed("Eco Deeper"));

    expect(mockSetSelectedModel).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith(
      `/settings?tab=models&switch=${encodeURIComponent(DEEP_ID)}`,
    );
  });

  // Downloaded bytes with no slot to bind them to is still an unbound pick —
  // it has to go through the flow that BINDS a slot, not straight to the store.
  it("routes a downloaded but unbound model through the download flow too", async () => {
    bindSlot("eco-fast", FAST_ID, "ready");
    mockSelectedModel = "eco-fast";
    vi.mocked(isModelDownloaded).mockResolvedValue(true);

    const user = await openSelector();
    await waitFor(() => {
      expect(within(tileNamed("Eco Deeper")).getByText("Downloaded")).toBeInTheDocument();
    });
    await user.click(tileNamed("Eco Deeper"));

    expect(mockSetSelectedModel).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith(
      `/settings?tab=models&switch=${encodeURIComponent(DEEP_ID)}`,
    );
  });

  it("just closes when the active tile is tapped", async () => {
    bindSlot("eco-fast", FAST_ID, "ready");
    mockSelectedModel = "eco-fast";

    const user = await openSelector();
    expect(tileNamed("Eco Fast")).toHaveAttribute("aria-selected", "true");

    await user.click(tileNamed("Eco Fast"));

    expect(mockSetSelectedModel).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox", { name: /select model/i })).not.toBeInTheDocument();
  });
});

describe("ModelSelector — never hide what is running", () => {
  it("appends a tile for the serving model when it is outside the pair", async () => {
    bindSlot("eco-fast", OUTSIDE_PAIR_ID, "ready");
    mockSelectedModel = "eco-fast";

    await openSelector();

    expect(tiles()).toHaveLength(3);
    const running = tileNamed("Eco Compact");
    expect(running).toHaveAttribute("aria-selected", "true");
    expect(within(running).getByText("Downloaded")).toBeInTheDocument();
    // Appended last — the device's own offer still leads.
    expect(tiles()[2]).toBe(running);
  });
});

describe("ModelSelector — the Recommended tag", () => {
  it("tags the recommended model when there is a real choice", async () => {
    await openSelector();

    const tag = within(getListbox()).getByText("Recommended");
    expect(tileNamed("Eco Fast")).toContainElement(tag);
  });

  it("shows no Recommended tag on a single-model device", async () => {
    offerSingle();

    await openSelector();

    expect(tiles()).toHaveLength(1);
    expect(within(getListbox()).queryByText("Recommended")).not.toBeInTheDocument();
  });
});

describe("ModelSelector — shell behavior is unchanged", () => {
  it("renders the composer trigger as a pill with a label after mount", async () => {
    bindSlot("eco-fast", FAST_ID, "ready");
    mockSelectedModel = "eco-fast";
    render(<ModelSelector />);

    const trigger = screen.getByTestId("model-selector");
    expect(trigger).toHaveClass("rounded-full");
    // One identity in the composer: the visible label is always "Eco". The
    // branded model name is demoted to the hover/aria detail.
    expect(trigger).toHaveTextContent("Eco");
    await waitFor(() => {
      expect(trigger).toHaveAttribute("title", "Eco Fast (Liquid)");
    });
  });

  // The selector has one mount, in the composer, pinned to the bottom of the
  // viewport — so the panel is anchored to the trigger's top edge and grows
  // upward. There is no downward case to choose between.
  it("anchors the desktop dropdown above the trigger", async () => {
    await openSelector();

    const panel = getListbox().parentElement;
    expect(panel).not.toBeNull();
    expect(panel?.style.position).toBe("fixed");
    expect(panel?.style.top).toBe("");
    expect(panel?.style.bottom).not.toBe("");
    expect(panel?.style.transformOrigin).toBe("bottom right");
  });

  it("renders the same tiles in the mobile bottom sheet", async () => {
    mockIsMobile = true;

    await openSelector();

    expect(tiles()).toHaveLength(2);
    expect(within(getListbox()).getByText("Eco Deeper")).toBeInTheDocument();
  });
});
