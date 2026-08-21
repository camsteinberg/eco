// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The composer selector offers the DEVICE PAIR, not the catalog.
 *
 * Three things this net exists to hold, none of which the old flat-list tests
 * covered at all:
 *   - download state is visible (the old list offered gigabytes of undownloaded
 *     models as if they were a click away),
 *   - selection writes a SLOT NAME, never a concrete model id — a store
 *     selection no slot owns is the exact state that let an undownloaded model
 *     reach the runtime, which then self-fetched it mid-turn, and
 *   - a model that isn't here is asked for, downloaded, and switched to IN THE
 *     TILE: confirm with a size, progress in the background, and a switch the
 *     person taps when it suits them.
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
import type { ModelUpgradeUi } from "../../../hooks/local-ai/useModelUpgrade";

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

// The pull machine, at its module boundary: the tile reads the shared UI state
// and calls two plain functions. Mocking it keeps this file about the surface.
let mockPullUi: ModelUpgradeUi = { kind: "hidden" };
const mockRequestPull = vi.fn();
const mockSwapNow = vi.fn();

vi.mock("../../../hooks/local-ai/useModelUpgrade", () => ({
  useModelUpgradeUi: () => mockPullUi,
  requestModelPull: (...args: unknown[]) => mockRequestPull(...args),
  swapPulledModelNow: (...args: unknown[]) => mockSwapNow(...args),
}));

let mockSelectedModel = "auto";
let mockIsStreaming = false;
const mockSetSelectedModel = vi.fn((model: string) => {
  mockSelectedModel = model;
});

vi.mock("../../../stores/chatStore", () => ({
  useChatStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        selectedModel: mockSelectedModel,
        setSelectedModel: mockSetSelectedModel,
        isStreaming: mockIsStreaming,
      }),
    {
      getState: () => ({
        selectedModel: mockSelectedModel,
        setSelectedModel: mockSetSelectedModel,
        isStreaming: mockIsStreaming,
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

/** The tile itself — the option, which holds the body button and any actions. */
function tileNamed(name: string): HTMLElement {
  const tile = within(getListbox()).getByText(name).closest('[role="option"]');
  if (!(tile instanceof HTMLElement)) throw new Error(`no tile named ${name}`);
  return tile;
}

/** Tap the tile the way a person does: its body, not its action buttons. */
async function tapTile(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
): Promise<void> {
  const body = within(tileNamed(name)).getAllByRole("button")[0];
  if (!body) throw new Error(`tile ${name} has no body button`);
  await user.click(body);
}

/** Every pull state, minus the model — which `pullFor` fills in from the catalog. */
type PullFixture = Exclude<ModelUpgradeUi, { kind: "hidden" }> extends infer U
  ? U extends { target: unknown }
    ? Omit<U, "target">
    : never
  : never;

/** A pull in some phase, aimed at one of the fixture models. */
function pullFor(id: string, pull: PullFixture): void {
  mockPullUi = { ...pull, target: catalogModel(id) } as ModelUpgradeUi;
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
  mockIsStreaming = false;
  mockPullUi = { kind: "hidden" };
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
    await tapTile(user, "Eco Deeper");

    expect(mockSetSelectedModel).toHaveBeenCalledWith("eco-smart", { explicit: true });
    // Never the concrete id — that is the unbound-selection state itself.
    for (const call of mockSetSelectedModel.mock.calls) {
      expect(["eco-fast", "eco-smart"]).toContain(call[0]);
    }
  });

  it("never selects an undownloaded model — it asks to download it instead", async () => {
    bindSlot("eco-fast", FAST_ID, "ready");
    mockSelectedModel = "eco-fast";

    const user = await openSelector();
    await tapTile(user, "Eco Deeper");

    expect(mockSetSelectedModel).not.toHaveBeenCalled();
    expect(mockRequestPull).not.toHaveBeenCalled();
    expect(within(tileNamed("Eco Deeper")).getByRole("button", { name: "Download" }))
      .toBeInTheDocument();
  });

  // Downloaded bytes with no slot to bind them to is still an unbound pick —
  // it has to go through the flow that BINDS a slot, not straight to the store.
  it("asks about a downloaded but unbound model too, rather than selecting it", async () => {
    bindSlot("eco-fast", FAST_ID, "ready");
    mockSelectedModel = "eco-fast";
    vi.mocked(isModelDownloaded).mockResolvedValue(true);

    const user = await openSelector();
    await waitFor(() => {
      expect(within(tileNamed("Eco Deeper")).getByText("Downloaded")).toBeInTheDocument();
    });
    await tapTile(user, "Eco Deeper");

    expect(mockSetSelectedModel).not.toHaveBeenCalled();
    expect(within(tileNamed("Eco Deeper")).getByRole("button", { name: "Download" }))
      .toBeInTheDocument();
  });

  it("just closes when the active tile is tapped", async () => {
    bindSlot("eco-fast", FAST_ID, "ready");
    mockSelectedModel = "eco-fast";

    const user = await openSelector();
    expect(tileNamed("Eco Fast")).toHaveAttribute("aria-selected", "true");

    await tapTile(user, "Eco Fast");

    expect(mockSetSelectedModel).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox", { name: /select model/i })).not.toBeInTheDocument();
  });
});

describe("ModelSelector — a model that isn't here downloads in place", () => {
  beforeEach(() => {
    bindSlot("eco-fast", FAST_ID, "ready");
    mockSelectedModel = "eco-fast";
  });

  it("says how big it is and that chat keeps working, before anything downloads", async () => {
    const user = await openSelector();
    await tapTile(user, "Eco Deeper");

    const deeper = tileNamed("Eco Deeper");
    expect(
      within(deeper).getByText(/Downloads ~1\.7 GB in the background/i),
    ).toBeInTheDocument();
    expect(within(deeper).getByText(/keep chatting/i)).toBeInTheDocument();
    expect(within(deeper).getByRole("button", { name: "Not now" })).toBeInTheDocument();
    // Still nothing downloading: the confirm is the consent.
    expect(mockRequestPull).not.toHaveBeenCalled();
  });

  it("'Not now' leaves nothing behind and the tile is immediately re-tappable", async () => {
    const user = await openSelector();
    await tapTile(user, "Eco Deeper");
    await user.click(within(tileNamed("Eco Deeper")).getByRole("button", { name: "Not now" }));

    expect(mockRequestPull).not.toHaveBeenCalled();
    expect(within(tileNamed("Eco Deeper")).queryByRole("button", { name: "Download" }))
      .not.toBeInTheDocument();
    // Asking again is one tap, with no memory of the refusal.
    await tapTile(user, "Eco Deeper");
    expect(within(tileNamed("Eco Deeper")).getByRole("button", { name: "Download" }))
      .toBeInTheDocument();
  });

  it("pulls the deeper model into eco-smart, and the everyday one into eco-fast", async () => {
    const user = await openSelector();
    await tapTile(user, "Eco Deeper");
    await user.click(within(tileNamed("Eco Deeper")).getByRole("button", { name: "Download" }));

    expect(mockRequestPull).toHaveBeenCalledWith("eco-smart", DEEP_ID);
    // Never a plain selection: the bytes have to arrive first.
    expect(mockSetSelectedModel).not.toHaveBeenCalled();
  });

  it("pulls an undownloaded everyday pick into eco-fast, the slot that pick owns", async () => {
    // The mirror case: this device is chatting on the deeper model and the
    // everyday pick is the one that has to be fetched.
    mockSlots = {
      "eco-fast": { modelId: null, status: "empty" },
      "eco-smart": { modelId: DEEP_ID, status: "ready" },
    };
    mockSelectedModel = "eco-smart";

    const user = await openSelector();
    await tapTile(user, "Eco Fast");
    await user.click(within(tileNamed("Eco Fast")).getByRole("button", { name: "Download" }));

    expect(mockRequestPull).toHaveBeenCalledWith("eco-fast", FAST_ID);
  });

  it("shows the download running on the tile it was asked for", async () => {
    pullFor(DEEP_ID, { kind: "downloading", slot: "eco-smart", percent: 0.42 });

    await openSelector();

    const deeper = tileNamed("Eco Deeper");
    expect(within(deeper).getByRole("progressbar")).toBeInTheDocument();
    expect(within(deeper).getByText("Downloading 42%")).toBeInTheDocument();
    // The other tile is untouched by someone else's download.
    expect(within(tileNamed("Eco Fast")).queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("offers the switch once it is ready, and never takes it on its own", async () => {
    pullFor(DEEP_ID, { kind: "ready", slot: "eco-smart" });

    const user = await openSelector();
    const switchNow = within(tileNamed("Eco Deeper")).getByRole("button", {
      name: /switch now/i,
    });
    await user.click(switchNow);

    expect(mockSwapNow).toHaveBeenCalledTimes(1);
    expect(mockSetSelectedModel).not.toHaveBeenCalled();
  });

  it("will not switch in the middle of a reply", async () => {
    mockIsStreaming = true;
    pullFor(DEEP_ID, { kind: "ready", slot: "eco-smart" });

    await openSelector();

    expect(within(tileNamed("Eco Deeper")).getByRole("button", { name: /switch now/i }))
      .toBeDisabled();
  });

  it("shows the swap preparing, on the same tile", async () => {
    pullFor(DEEP_ID, { kind: "swapping", slot: "eco-smart", percent: 0.5 });

    await openSelector();

    expect(within(tileNamed("Eco Deeper")).getByText("Preparing 50%")).toBeInTheDocument();
  });

  it("a deferred pull says why, and the tile stays tappable to try again", async () => {
    pullFor(DEEP_ID, {
      kind: "deferred",
      slot: "eco-smart",
      deferral: { code: "insufficient-storage", message: "Eco needs about 1 GB more room." },
    });

    const user = await openSelector();
    const deeper = tileNamed("Eco Deeper");
    expect(within(deeper).getByText("Eco needs about 1 GB more room.")).toBeInTheDocument();

    await tapTile(user, "Eco Deeper");
    expect(within(tileNamed("Eco Deeper")).getByRole("button", { name: "Download" }))
      .toBeInTheDocument();
  });

  it("tells the composer trigger that a model is waiting to be switched to", async () => {
    pullFor(DEEP_ID, { kind: "ready", slot: "eco-smart" });

    render(<ModelSelector />);

    await waitFor(() => {
      expect(screen.getByTestId("model-selector")).toHaveAttribute(
        "aria-label",
        expect.stringContaining("ready to switch to"),
      );
    });
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

  it("keeps the bottom sheet open when a tile inside it is tapped", async () => {
    // The sheet is portalled out of this component's subtree, so the pointer
    // layout's click-outside listener read every tap INSIDE it as a tap outside
    // and closed it. Harmless while every tap was a selection that closed the
    // panel anyway; it swallowed the whole confirm on touch.
    mockIsMobile = true;
    bindSlot("eco-fast", FAST_ID, "ready");
    mockSelectedModel = "eco-fast";

    const user = await openSelector();
    await tapTile(user, "Eco Deeper");

    expect(getListbox()).toBeInTheDocument();
    expect(within(tileNamed("Eco Deeper")).getByRole("button", { name: "Download" }))
      .toBeInTheDocument();
  });
});
