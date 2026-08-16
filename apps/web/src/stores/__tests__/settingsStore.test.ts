// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  openSettingsDB,
  encryptSetting,
  decryptSetting,
} = vi.hoisted(() => ({
  openSettingsDB: vi.fn(),
  encryptSetting: vi.fn((value: string) => ({
    ciphertext: `enc:${value}`,
    nonce: "nonce",
  })),
  decryptSetting: vi.fn((ciphertext: string) => {
    if (ciphertext === "bad") {
      throw new Error("Decryption failed");
    }
    return ciphertext.replace(/^enc:/, "");
  }),
}));

vi.mock("../../lib/settings-db", () => ({
  openSettingsDB,
  encryptSetting,
  decryptSetting,
}));

import {
  canUseExternalLookups,
  isExternalLookupExplicitlyOff,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  useSettingsStore,
} from "../settingsStore";

type FakeDb = {
  get: ReturnType<typeof vi.fn>;
  getAll: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function makeFakeDb(): FakeDb {
  return {
    get: vi.fn(),
    getAll: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    close: vi.fn(),
  };
}

function resetStore() {
  useSettingsStore.setState({
    customInstructions: "",
    hasLoaded: false,
    lifetimeQueryCount: 0,
    soundsEnabled: false,
    autoAcceptTools: true,
    showTechnicalDetails: false,
    groundingEnabled: true,
    groundingNoticeSeen: false,
  });
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("canUseExternalLookups", () => {
  it("fails closed while settings are still hydrating", () => {
    expect(canUseExternalLookups({ hasLoaded: false, groundingEnabled: true })).toBe(false);
  });

  it("allows browser-direct lookups once hydrated and enabled", () => {
    expect(canUseExternalLookups({ hasLoaded: true, groundingEnabled: true })).toBe(true);
  });

  it("blocks browser-direct lookups once hydrated and disabled", () => {
    expect(canUseExternalLookups({ hasLoaded: true, groundingEnabled: false })).toBe(false);
  });
});

describe("isExternalLookupExplicitlyOff", () => {
  it("is true only once hydrated AND the switch is off", () => {
    expect(
      isExternalLookupExplicitlyOff({ hasLoaded: true, groundingEnabled: false }),
    ).toBe(true);
  });

  it("is false on the unhydrated race — we don't yet know the user's choice (F-1)", () => {
    // The key distinction from `canUseExternalLookups` being false: here we must NOT
    // claim "lookups are off" because the persisted choice may be on.
    expect(
      isExternalLookupExplicitlyOff({ hasLoaded: false, groundingEnabled: false }),
    ).toBe(false);
    expect(
      isExternalLookupExplicitlyOff({ hasLoaded: false, groundingEnabled: true }),
    ).toBe(false);
  });

  it("is false when hydrated and enabled", () => {
    expect(
      isExternalLookupExplicitlyOff({ hasLoaded: true, groundingEnabled: true }),
    ).toBe(false);
  });
});

describe("useSettingsStore.loadFromDB", () => {
  it("hydrates settings from IndexedDB and closes the DB", async () => {
    const db = makeFakeDb();
    db.get.mockImplementation(async (_store: string, key: string) => {
      switch (key) {
        case "custom-instructions":
          return { ciphertext: "enc:Be concise", nonce: "nonce" };
        case "sounds-enabled":
          return { ciphertext: "enc:true", nonce: "nonce" };
        case "auto-accept-tools":
          return { ciphertext: "enc:false", nonce: "nonce" };
        case "lifetime-query-count":
          return { ciphertext: "enc:7", nonce: "nonce" };
        case "show-technical-details":
          return { ciphertext: "enc:true", nonce: "nonce" };
        case "grounding-enabled":
          return { ciphertext: "enc:false", nonce: "nonce" };
        default:
          return undefined;
      }
    });
    openSettingsDB.mockResolvedValue(db);

    await useSettingsStore.getState().loadFromDB();

    expect(useSettingsStore.getState()).toMatchObject({
      customInstructions: "Be concise",
      hasLoaded: true,
      lifetimeQueryCount: 7,
      soundsEnabled: true,
      autoAcceptTools: false,
      showTechnicalDetails: true,
      groundingEnabled: false,
    });
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("removes corrupted settings during hydration", async () => {
    const db = makeFakeDb();
    db.get.mockImplementation(async (_store: string, key: string) => {
      if (key === "custom-instructions") {
        return { ciphertext: "bad", nonce: "nonce" };
      }
      return undefined;
    });
    openSettingsDB.mockResolvedValue(db);

    await useSettingsStore.getState().loadFromDB();

    expect(useSettingsStore.getState().customInstructions).toBe("");
    expect(db.delete).toHaveBeenCalledWith("settings", "custom-instructions");
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("clamps an over-long persisted custom-instructions value on load (HON-3)", async () => {
    const overLong = "y".repeat(MAX_CUSTOM_INSTRUCTIONS_LENGTH + 800);
    const db = makeFakeDb();
    db.get.mockImplementation(async (_store: string, key: string) => {
      if (key === "custom-instructions") {
        return { ciphertext: `enc:${overLong}`, nonce: "nonce" };
      }
      return undefined;
    });
    openSettingsDB.mockResolvedValue(db);

    await useSettingsStore.getState().loadFromDB();

    // A value that pre-dates the cap (or was written straight to IndexedDB) is
    // truncated on load, so it can never reach the prompt over-length.
    expect(useSettingsStore.getState().customInstructions).toBe(
      "y".repeat(MAX_CUSTOM_INSTRUCTIONS_LENGTH),
    );
    expect(useSettingsStore.getState().customInstructions.length).toBe(
      MAX_CUSTOM_INSTRUCTIONS_LENGTH,
    );
  });

  it("marks the store as loaded but keeps browser-direct lookups fail-closed if IndexedDB open fails", async () => {
    openSettingsDB.mockRejectedValue(new Error("IDB unavailable"));

    await useSettingsStore.getState().loadFromDB();

    expect(useSettingsStore.getState()).toMatchObject({
      hasLoaded: true,
      groundingEnabled: false,
    });
    expect(canUseExternalLookups(useSettingsStore.getState())).toBe(false);
  });

  it("defaults showTechnicalDetails to false when no stored value exists", async () => {
    const db = makeFakeDb();
    db.get.mockResolvedValue(undefined);
    db.getAll.mockResolvedValue([]);
    openSettingsDB.mockResolvedValue(db);

    await useSettingsStore.getState().loadFromDB();

    expect(useSettingsStore.getState().showTechnicalDetails).toBe(false);
  });

  it("defaults groundingEnabled to true when no stored value exists", async () => {
    const db = makeFakeDb();
    db.get.mockResolvedValue(undefined);
    db.getAll.mockResolvedValue([]);
    openSettingsDB.mockResolvedValue(db);

    await useSettingsStore.getState().loadFromDB();

    expect(useSettingsStore.getState().groundingEnabled).toBe(true);
  });

  it("rehydrates a persisted groundingEnabled:false (the off switch survives reload)", async () => {
    const db = makeFakeDb();
    db.get.mockImplementation(async (_store: string, key: string) =>
      key === "grounding-enabled"
        ? { ciphertext: "enc:false", nonce: "nonce" }
        : undefined,
    );
    openSettingsDB.mockResolvedValue(db);

    await useSettingsStore.getState().loadFromDB();

    expect(useSettingsStore.getState().groundingEnabled).toBe(false);
  });

  it("repairs a corrupted persisted web lookup setting to durable fail-closed false", async () => {
    const db = makeFakeDb();
    let groundingRecord: { key: string; ciphertext: string; nonce: string } | undefined = {
      key: "grounding-enabled",
      ciphertext: "bad",
      nonce: "nonce",
    };
    db.get.mockImplementation(async (_store: string, key: string) =>
      key === "grounding-enabled" ? groundingRecord : undefined,
    );
    db.put.mockImplementation(async (_store: string, value: typeof groundingRecord) => {
      if (value?.key === "grounding-enabled") {
        groundingRecord = value;
      }
    });
    db.delete.mockImplementation(async (_store: string, key: string) => {
      if (key === "grounding-enabled") {
        groundingRecord = undefined;
      }
    });
    openSettingsDB.mockResolvedValue(db);

    await useSettingsStore.getState().loadFromDB();

    expect(useSettingsStore.getState()).toMatchObject({
      hasLoaded: true,
      groundingEnabled: false,
    });
    expect(canUseExternalLookups(useSettingsStore.getState())).toBe(false);
    expect(encryptSetting).toHaveBeenCalledWith("false");
    expect(db.put).toHaveBeenCalledWith("settings", {
      key: "grounding-enabled",
      ciphertext: "enc:false",
      nonce: "nonce",
    });
    expect(db.delete).not.toHaveBeenCalledWith("settings", "grounding-enabled");

    resetStore();
    await useSettingsStore.getState().loadFromDB();

    expect(useSettingsStore.getState().groundingEnabled).toBe(false);
    expect(canUseExternalLookups(useSettingsStore.getState())).toBe(false);
  });

  it("repairs invalid plaintext in the persisted web lookup setting to durable fail-closed false", async () => {
    const db = makeFakeDb();
    let groundingRecord: { key: string; ciphertext: string; nonce: string } | undefined = {
      key: "grounding-enabled",
      ciphertext: "enc:maybe",
      nonce: "nonce",
    };
    db.get.mockImplementation(async (_store: string, key: string) =>
      key === "grounding-enabled" ? groundingRecord : undefined,
    );
    db.put.mockImplementation(async (_store: string, value: typeof groundingRecord) => {
      if (value?.key === "grounding-enabled") {
        groundingRecord = value;
      }
    });
    db.delete.mockImplementation(async (_store: string, key: string) => {
      if (key === "grounding-enabled") {
        groundingRecord = undefined;
      }
    });
    openSettingsDB.mockResolvedValue(db);

    await useSettingsStore.getState().loadFromDB();

    expect(useSettingsStore.getState()).toMatchObject({
      hasLoaded: true,
      groundingEnabled: false,
    });
    expect(canUseExternalLookups(useSettingsStore.getState())).toBe(false);
    expect(encryptSetting).toHaveBeenCalledWith("false");
    expect(db.put).toHaveBeenCalledWith("settings", {
      key: "grounding-enabled",
      ciphertext: "enc:false",
      nonce: "nonce",
    });
    expect(db.delete).not.toHaveBeenCalledWith("settings", "grounding-enabled");

    resetStore();
    await useSettingsStore.getState().loadFromDB();

    expect(useSettingsStore.getState().groundingEnabled).toBe(false);
    expect(canUseExternalLookups(useSettingsStore.getState())).toBe(false);
  });

  it("defaults groundingNoticeSeen to false when no stored value exists", async () => {
    const db = makeFakeDb();
    db.get.mockResolvedValue(undefined);
    db.getAll.mockResolvedValue([]);
    openSettingsDB.mockResolvedValue(db);

    await useSettingsStore.getState().loadFromDB();

    expect(useSettingsStore.getState().groundingNoticeSeen).toBe(false);
  });

  it("rehydrates a persisted groundingNoticeSeen:true (the notice never returns)", async () => {
    const db = makeFakeDb();
    db.get.mockImplementation(async (_store: string, key: string) =>
      key === "grounding-notice-seen"
        ? { ciphertext: "enc:true", nonce: "nonce" }
        : undefined,
    );
    openSettingsDB.mockResolvedValue(db);

    await useSettingsStore.getState().loadFromDB();

    expect(useSettingsStore.getState().groundingNoticeSeen).toBe(true);
  });
});

describe("useSettingsStore writes", () => {
  it("persists custom instructions and closes the DB after writing", async () => {
    const db = makeFakeDb();
    openSettingsDB.mockResolvedValue(db);

    useSettingsStore.getState().setCustomInstructions("Trust the system less");
    await flushAsyncWork();

    expect(encryptSetting).toHaveBeenCalledWith("Trust the system less");
    expect(db.put).toHaveBeenCalledWith("settings", {
      key: "custom-instructions",
      ciphertext: "enc:Trust the system less",
      nonce: "nonce",
    });
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("clamps an over-long custom-instructions value at the store boundary on write (HON-3)", async () => {
    const db = makeFakeDb();
    openSettingsDB.mockResolvedValue(db);

    const clamped = "x".repeat(MAX_CUSTOM_INSTRUCTIONS_LENGTH);
    useSettingsStore.getState().setCustomInstructions(
      "x".repeat(MAX_CUSTOM_INSTRUCTIONS_LENGTH + 500),
    );
    await flushAsyncWork();

    // Both the in-memory state and the encrypted DB write are capped, so an
    // over-long value can't reach the prompt even if the editor's maxLength is
    // bypassed.
    expect(useSettingsStore.getState().customInstructions).toBe(clamped);
    expect(encryptSetting).toHaveBeenCalledWith(clamped);
  });

  it("flips and persists showTechnicalDetails under a stable key", async () => {
    const db = makeFakeDb();
    openSettingsDB.mockResolvedValue(db);

    useSettingsStore.getState().setShowTechnicalDetails(true);
    await flushAsyncWork();

    expect(useSettingsStore.getState().showTechnicalDetails).toBe(true);
    expect(encryptSetting).toHaveBeenCalledWith("true");
    expect(db.put).toHaveBeenCalledWith("settings", {
      key: "show-technical-details",
      ciphertext: "enc:true",
      nonce: "nonce",
    });
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("defaults groundingEnabled to true", () => {
    expect(useSettingsStore.getState().groundingEnabled).toBe(true);
  });

  it("flips and persists groundingEnabled under a stable key", async () => {
    const db = makeFakeDb();
    openSettingsDB.mockResolvedValue(db);

    useSettingsStore.getState().setGroundingEnabled(false);
    await flushAsyncWork();

    expect(useSettingsStore.getState().groundingEnabled).toBe(false);
    expect(encryptSetting).toHaveBeenCalledWith("false");
    expect(db.put).toHaveBeenCalledWith("settings", {
      key: "grounding-enabled",
      ciphertext: "enc:false",
      nonce: "nonce",
    });
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("defaults groundingNoticeSeen to false", () => {
    expect(useSettingsStore.getState().groundingNoticeSeen).toBe(false);
  });

  it("flips and persists groundingNoticeSeen under a stable key", async () => {
    const db = makeFakeDb();
    openSettingsDB.mockResolvedValue(db);

    useSettingsStore.getState().setGroundingNoticeSeen();
    await flushAsyncWork();

    expect(useSettingsStore.getState().groundingNoticeSeen).toBe(true);
    expect(encryptSetting).toHaveBeenCalledWith("true");
    expect(db.put).toHaveBeenCalledWith("settings", {
      key: "grounding-notice-seen",
      ciphertext: "enc:true",
      nonce: "nonce",
    });
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("is one-way: setGroundingNoticeSeen ignores repeat calls (no extra write)", async () => {
    const db = makeFakeDb();
    openSettingsDB.mockResolvedValue(db);

    useSettingsStore.getState().setGroundingNoticeSeen();
    await flushAsyncWork();
    useSettingsStore.getState().setGroundingNoticeSeen();
    await flushAsyncWork();

    expect(useSettingsStore.getState().groundingNoticeSeen).toBe(true);
    // Only the first call writes; the guard short-circuits the second.
    expect(db.put).toHaveBeenCalledTimes(1);
  });
});
