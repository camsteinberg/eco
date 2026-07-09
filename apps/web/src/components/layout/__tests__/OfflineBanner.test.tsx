// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * OfflineBanner — model-aware two-state copy (Dim D PR-D6).
 *
 * Drives the REAL slot store (FakeStorage + a real catalog model id) and the
 * network status through navigator.onLine + online/offline events, so the
 * reactive useSyncExternalStore transitions are exercised at the store level
 * (per the project's useSyncExternalStore/act() pitfall) rather than mocked.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { OfflineBanner } from "../OfflineBanner";
import {
  _resetSlotsForTesting,
  setSlot,
  setSlotStatus,
  setSlotStorage,
  type KeyValueStorage,
} from "../../../local-ai/lifecycle/slots";

// A real catalog id so the slot resolves to a concrete model (empty otherwise).
const READY_MODEL_ID = "local/qwen3-0.6b";

class FakeStorage implements KeyValueStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

let online = true;

function setOnline(next: boolean): void {
  act(() => {
    online = next;
    window.dispatchEvent(new Event(next ? "online" : "offline"));
  });
}

function markModelReady(): void {
  act(() => {
    setSlot("eco-fast", READY_MODEL_ID);
    setSlotStatus("eco-fast", "ready");
  });
}

beforeEach(() => {
  online = true;
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
  setSlotStorage(new FakeStorage());
});

afterEach(() => {
  cleanup();
  _resetSlotsForTesting();
});

describe("OfflineBanner", () => {
  it("renders nothing while online", () => {
    render(<OfflineBanner />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the honest setup framing when offline with no model ready", () => {
    render(<OfflineBanner />);
    setOnline(false);

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("You're offline.");
    expect(banner.textContent).toContain(
      "Eco needs to connect just once to set up your on-device AI.",
    );
    expect(banner.textContent).toContain("Come back online to get started.");
    // The brand-moment copy must NOT appear in the no-model state.
    expect(banner.textContent).not.toContain("runs right here on your device");
  });

  it("shows the local-first brand copy when offline with a model ready", () => {
    markModelReady();
    render(<OfflineBanner />);
    setOnline(false);

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("You're offline — and that's okay.");
    expect(banner.textContent).toContain(
      "Your AI runs right here on your device.",
    );
    // Honesty clause: lookups genuinely pause offline (decline-on-no-source).
    expect(banner.textContent).toContain(
      "Web lookups are paused until you're back online.",
    );
    expect(banner.textContent).not.toContain("needs to connect just once");
  });

  it("swaps setup copy for brand copy when a model becomes ready while offline", () => {
    render(<OfflineBanner />);
    setOnline(false);

    // Starts in the no-model state.
    expect(screen.getByRole("status").textContent).toContain(
      "Eco needs to connect just once",
    );

    // A slot becoming ready is a store notify → reactive re-render.
    markModelReady();

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain(
      "Your AI runs right here on your device.",
    );
    expect(banner.textContent).not.toContain("needs to connect just once");
  });

  it("hides the banner again when the network returns", () => {
    render(<OfflineBanner />);
    setOnline(false);
    expect(screen.getByRole("status")).not.toBeNull();

    setOnline(true);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
