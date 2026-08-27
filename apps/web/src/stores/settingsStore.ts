// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { create } from "zustand";
import { openSettingsDB, encryptSetting, decryptSetting, ensureSettingsKey } from "../lib/settings-db";
import { logger } from "../lib/logger";

type SettingsDatabase = Awaited<ReturnType<typeof openSettingsDB>>;

/**
 * Hard cap on custom-instructions length. Enforced at the store boundary — both
 * on write (`setCustomInstructions`) and on DB load (`loadFromDB`) — not only in
 * the editor UI, so an over-long value can never reach the prompt regardless of
 * how it got into storage (HON-3). The editor imports this same constant.
 */
export const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 1500;

type SettingsState = {
  customInstructions: string;
  hasLoaded: boolean;
  lifetimeQueryCount: number;
  soundsEnabled: boolean;
  autoAcceptTools: boolean;
  showTechnicalDetails: boolean;
  /**
   * Whether on-device grounding (Wikipedia/Wikidata fact lookups, #5) is allowed.
   * Default-ON with an easy off switch (locked decision). When false, the chat
   * pipeline drops the citation tool so a factual turn never hits the network and
   * falls through to normal on-device generation — keeping every request fully on
   * this device.
   */
  groundingEnabled: boolean;
  /**
   * Whether the one-time "first grounded answer" disclosure (#5 S5-notice) has
   * been shown. Grounding ships default-ON, so the first time a turn actually
   * produces a grounded answer we surface a calm, dismissible note under it that
   * honestly discloses the device fetched from Wikipedia directly. It appears
   * once ever — once true (on dismiss or "Manage"), it never returns. One-way.
   */
  groundingNoticeSeen: boolean;
};

type SettingsActions = {
  setCustomInstructions: (text: string) => void;
  setSoundsEnabled: (enabled: boolean) => void;
  setAutoAcceptTools: (enabled: boolean) => void;
  setShowTechnicalDetails: (enabled: boolean) => void;
  setGroundingEnabled: (enabled: boolean) => void;
  setGroundingNoticeSeen: () => void;
  loadFromDB: () => Promise<void>;
  incrementLifetimeQueryCount: () => void;
};

type ExternalLookupSettings = Pick<SettingsState, "hasLoaded" | "groundingEnabled">;

/**
 * Browser-direct lookups are allowed only after settings hydrate and the user has
 * the web lookup switch on. Unknown settings fail closed so a persisted opt-out
 * cannot be bypassed during reload or pending-prompt races.
 */
export function canUseExternalLookups(settings: ExternalLookupSettings): boolean {
  return settings.hasLoaded && settings.groundingEnabled;
}

/**
 * The user has EXPLICITLY opted out of web lookups: settings have hydrated AND the
 * switch is off. Distinct from {@link canUseExternalLookups} being false, which is
 * also true on the transient unhydrated race (`!hasLoaded`). The chat pipeline uses
 * this to decide whether to inject an honest "web lookups are off" decline (F-1):
 * only when we KNOW the user turned them off — never on the unhydrated race, where
 * claiming "lookups are off" could be false (they may have them on).
 */
export function isExternalLookupExplicitlyOff(
  settings: ExternalLookupSettings,
): boolean {
  return settings.hasLoaded && !settings.groundingEnabled;
}

/** Safe IndexedDB write — ensures db.close() is called even if the operation throws */
async function safeSettingsWrite(
  fn: (db: SettingsDatabase) => Promise<void>,
  label: string,
): Promise<void> {
  let db: SettingsDatabase | undefined;
  try {
    db = await openSettingsDB();
    await fn(db);
  } catch (err) {
    logger.warn(`Failed to save ${label}:`, err);
  } finally {
    db?.close();
  }
}

function parseStrictBooleanSetting(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Invalid boolean setting value");
}

async function readSettingValue<T>(
  db: SettingsDatabase,
  key: string,
  label: string,
  defaultValue: T,
  parse: (value: string) => T,
  corruptDefaultValue = defaultValue,
  corruptRepairPlaintext?: string,
): Promise<T> {
  const record = await db.get("settings", key);
  if (!record) {
    return defaultValue;
  }

  try {
    return parse(decryptSetting(record.ciphertext, record.nonce));
  } catch (err) {
    // Keep the record: with the key backed up in IndexedDB a decrypt failure
    // is rare and the bytes may still be recoverable. Only the fail-closed
    // repair path (web lookups) overwrites it, on purpose.
    logger.warn(`Failed to decrypt ${label}. Using the default for this session.`, err);
    if (corruptRepairPlaintext !== undefined) {
      const encrypted = encryptSetting(corruptRepairPlaintext);
      await db.put("settings", { key, ciphertext: encrypted.ciphertext, nonce: encrypted.nonce });
    }
    return corruptDefaultValue;
  }
}

export const useSettingsStore = create<SettingsState & SettingsActions>()(
  (set, get) => ({
    customInstructions: "",
    hasLoaded: false,
    lifetimeQueryCount: 0,
    soundsEnabled: false,
    autoAcceptTools: true,
    showTechnicalDetails: false,
    groundingEnabled: true,
    groundingNoticeSeen: false,

    setCustomInstructions(text: string) {
      const clamped = text.slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH);
      set({ customInstructions: clamped });
      void safeSettingsWrite(async (db) => {
        const encrypted = encryptSetting(clamped);
        await db.put("settings", {
          key: "custom-instructions",
          ciphertext: encrypted.ciphertext,
          nonce: encrypted.nonce,
        });
      }, "custom-instructions");
    },

    setSoundsEnabled(enabled: boolean) {
      set({ soundsEnabled: enabled });
      void safeSettingsWrite(async (db) => {
        const encrypted = encryptSetting(String(enabled));
        await db.put("settings", { key: "sounds-enabled", ciphertext: encrypted.ciphertext, nonce: encrypted.nonce });
      }, "sounds-enabled");
    },

    setAutoAcceptTools(enabled: boolean) {
      set({ autoAcceptTools: enabled });
      void safeSettingsWrite(async (db) => {
        const encrypted = encryptSetting(String(enabled));
        await db.put("settings", { key: "auto-accept-tools", ciphertext: encrypted.ciphertext, nonce: encrypted.nonce });
      }, "auto-accept-tools");
    },

    setShowTechnicalDetails(enabled: boolean) {
      set({ showTechnicalDetails: enabled });
      void safeSettingsWrite(async (db) => {
        const encrypted = encryptSetting(String(enabled));
        await db.put("settings", { key: "show-technical-details", ciphertext: encrypted.ciphertext, nonce: encrypted.nonce });
      }, "show-technical-details");
    },

    setGroundingEnabled(enabled: boolean) {
      set({ groundingEnabled: enabled });
      void safeSettingsWrite(async (db) => {
        const encrypted = encryptSetting(String(enabled));
        await db.put("settings", { key: "grounding-enabled", ciphertext: encrypted.ciphertext, nonce: encrypted.nonce });
      }, "grounding-enabled");
    },

    setGroundingNoticeSeen() {
      // One-way: the disclosure is shown once, ever. Guard re-writes so the
      // setter is idempotent and never flips back.
      if (get().groundingNoticeSeen) return;
      set({ groundingNoticeSeen: true });
      void safeSettingsWrite(async (db) => {
        const encrypted = encryptSetting("true");
        await db.put("settings", { key: "grounding-notice-seen", ciphertext: encrypted.ciphertext, nonce: encrypted.nonce });
      }, "grounding-notice-seen");
    },

    async loadFromDB() {
      let db: SettingsDatabase | undefined;
      try {
        await ensureSettingsKey();
        db = await openSettingsDB();

        const customInstructions = await readSettingValue(
          db,
          "custom-instructions",
          "custom instructions",
          "",
          (value) => value.slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH),
        );
        const soundsEnabled = await readSettingValue(
          db,
          "sounds-enabled",
          "sounds-enabled",
          false,
          (value) => value === "true",
        );
        const autoAcceptTools = await readSettingValue(
          db,
          "auto-accept-tools",
          "auto-accept-tools",
          true,
          (value) => value !== "false",
        );
        const lifetimeQueryCount = await readSettingValue(
          db,
          "lifetime-query-count",
          "lifetime query count",
          0,
          (value) => {
            const parsed = Number.parseInt(value, 10);
            return Number.isFinite(parsed) ? parsed : 0;
          },
        );
        const showTechnicalDetails = await readSettingValue(
          db,
          "show-technical-details",
          "show-technical-details",
          false,
          (value) => value === "true",
        );
        const groundingEnabled = await readSettingValue(
          db,
          "grounding-enabled",
          "grounding-enabled",
          true,
          parseStrictBooleanSetting,
          false,
          "false",
        );
        const groundingNoticeSeen = await readSettingValue(
          db,
          "grounding-notice-seen",
          "grounding-notice-seen",
          false,
          (value) => value === "true",
        );

        set({
          customInstructions, lifetimeQueryCount, soundsEnabled, autoAcceptTools,
          showTechnicalDetails, groundingEnabled, groundingNoticeSeen,
          hasLoaded: true,
        });
      } catch (err) {
        logger.warn("Failed to load settings from DB:", err);
        set({ groundingEnabled: false, hasLoaded: true });
      } finally {
        db?.close();
      }
    },

    incrementLifetimeQueryCount() {
      const newCount = get().lifetimeQueryCount + 1;
      set({ lifetimeQueryCount: newCount });
      void safeSettingsWrite(async (db) => {
        const encrypted = encryptSetting(String(newCount));
        await db.put("settings", { key: "lifetime-query-count", ciphertext: encrypted.ciphertext, nonce: encrypted.nonce });
      }, "lifetime-query-count");
    },
  })
);
