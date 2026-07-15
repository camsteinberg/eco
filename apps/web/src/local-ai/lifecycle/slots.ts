// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Slots — single source of truth for slot state.
 *
 * Invariant 3: ALL slot reads/writes within `local-ai/` go through this
 * file. Other files in the subtree may import from here but must not
 * touch the `eco-local-ai-slot-*` localStorage keys directly.
 *
 * Storage layout:
 *   eco-local-ai-slot-eco-fast  → ModelConfig.id | (empty value = no model)
 *   eco-local-ai-slot-eco-smart → ModelConfig.id | (empty value = no model)
 *   eco-local-ai-slot-status-eco-fast  → 'empty' | 'preparing' | 'ready' | 'error'
 *   eco-local-ai-slot-status-eco-smart → 'empty' | 'preparing' | 'ready' | 'error'
 *
 * Legacy migration: on first read of either slot, the module also reads
 * the legacy `eco-slot-*` and `eco-model-slot-*` keys that the old
 * ModelManagement surface wrote. If a legacy key has a value and the new
 * key doesn't, the value migrates forward and the legacy key is left in
 * place.
 *
 * The catalog is the production source of truth for ModelConfig — we persist
 * the id only, then resolve via `catalog.getModel(id)`. Local validation can
 * also resolve eval-only candidates while the mission harness is enabled; those
 * ids still read as empty in production. If a stored id no longer exists in the
 * allowed model set, the slot reads as empty and the consumer can re-recommend.
 */

import type { ModelConfig, Slot } from '../types';
import { getModel } from '../catalog/catalog';
import { getEvalCandidateModel } from '../eval/eval-candidates';
import {
  getValidationSlotModelOverride,
  getValidationSlotStatusOverride,
  isValidationHarnessEnabled,
} from '../../lib/validation-harness';

// ─── Storage keys ──────────────────────────────────────────────────────────

const KEY_PREFIX = 'eco-local-ai-slot-';
const STATUS_KEY_PREFIX = 'eco-local-ai-slot-status-';

const LEGACY_KEY_PREFIXES: ReadonlyArray<string> = [
  'eco-model-slot-',
  'eco-slot-',
];

// ─── Types ─────────────────────────────────────────────────────────────────

export type SlotStatus = 'empty' | 'preparing' | 'ready' | 'error';

export type SlotState = {
  slot: Slot;
  modelId: string | null;
  model: ModelConfig | null;
  status: SlotStatus;
};

export type SlotStorageOverride = {
  storage?: KeyValueStorage;
};

export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

// ─── Storage resolution ────────────────────────────────────────────────────

let injectedStorage: KeyValueStorage | null = null;

/**
 * Override the storage backend. Tests pass an in-memory map. Production
 * leaves it null (we default to globalThis.localStorage at call time).
 */
export function setSlotStorage(storage: KeyValueStorage | null): void {
  injectedStorage = storage;
}

function resolveStorage(): KeyValueStorage | null {
  if (injectedStorage) return injectedStorage;
  if (typeof globalThis === 'undefined') return null;
  const g = globalThis as { localStorage?: KeyValueStorage };
  return g.localStorage ?? null;
}

// ─── Subscriber registry ───────────────────────────────────────────────────

type SlotChangeHandler = (slot: Slot, state: SlotState) => void;
const subscribers = new Set<SlotChangeHandler>();

export function subscribe(handler: SlotChangeHandler): () => void {
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}

function notify(slot: Slot): void {
  if (subscribers.size === 0) return;
  const state = getSlot(slot);
  for (const handler of subscribers) handler(slot, state);
}

// ─── Public API ────────────────────────────────────────────────────────────

export const SLOTS: ReadonlyArray<Slot> = ['eco-fast', 'eco-smart'];

export function getSlot(slot: Slot): SlotState {
  const modelId = readSlotId(slot);
  const status = readSlotStatus(slot);
  const model = modelId ? getSlotModel(modelId) : null;
  return {
    slot,
    modelId: model ? modelId : null,
    model,
    status: !model ? 'empty' : status,
  };
}

function getSlotModel(modelId: string): ModelConfig | null {
  const catalogModel = getModel(modelId);
  if (catalogModel) return catalogModel;

  if (!isValidationHarnessEnabled()) {
    return null;
  }

  return getEvalCandidateModel(modelId);
}

export function getAllSlots(): Record<Slot, SlotState> {
  return {
    'eco-fast': getSlot('eco-fast'),
    'eco-smart': getSlot('eco-smart'),
  };
}

export function setSlot(slot: Slot, model: ModelConfig | string | null): void {
  const storage = resolveStorage();
  if (!storage) return;
  const id = typeof model === 'string' ? model : model?.id ?? null;
  if (id) {
    // Status describes the BYTES of the currently-bound model. Binding a
    // DIFFERENT id (a switch/upgrade that binds pre-download, a reconcile flip)
    // means those bytes are unverified until the pipeline drives the slot to
    // 'ready', so force 'preparing'. Without this, a reload mid-switch leaves
    // the slot falsely 'ready' on a model that never finished downloading — the
    // "phantom pick" (Settings claims it's running, chat refuses, nothing
    // resumes). A same-id re-bind preserves status: the bytes it describes are
    // unchanged. An 'empty' slot also becomes 'preparing' so a freshly-assigned
    // slot never reads as 'empty' before the pipeline runs.
    const previousId = readSlotId(slot);
    storage.setItem(slotKey(slot), id);
    if (id !== previousId || readSlotStatus(slot) === 'empty') {
      storage.setItem(statusKey(slot), 'preparing');
    }
  } else {
    storage.removeItem(slotKey(slot));
    storage.removeItem(statusKey(slot));
  }
  notify(slot);
}

export function setSlotStatus(slot: Slot, status: SlotStatus): void {
  const storage = resolveStorage();
  if (!storage) return;
  storage.setItem(statusKey(slot), status);
  notify(slot);
}

export function clearSlot(slot: Slot): void {
  setSlot(slot, null);
}

export function clearAllSlots(): void {
  for (const slot of SLOTS) clearSlot(slot);
}

// ─── Slot display info ────────────────────────────────────────────────────

// The two slots are ROLES of one evolving Eco, not separate products. The
// labels describe what each role does for the person — the instant-on model
// that answers the moment they arrive, and the strongest model their device
// can run — so nothing here reads as a second assistant. Branded model names
// (e.g. "Eco (Qwen)") stay as secondary transparency in `display.ts`, surfaced
// as the "Currently running" name and behind hover, not as slot identities.
const SLOT_DISPLAY: Record<Slot, { displayName: string; description: string }> = {
  'eco-fast': { displayName: 'Instant start', description: 'Answers the moment you arrive' },
  'eco-smart': { displayName: 'Main model', description: 'The strongest Eco for this device' },
};

export type SlotDisplayInfo = SlotState & {
  displayName: string;
  description: string;
};

/**
 * Return display-ready info for every slot. Used by hardware-description —
 * replaces the legacy `getLocalModelSlotAssignmentDetails` from
 * `lib/local-model-routing.ts`.
 */
export function getSlotDisplayInfos(): SlotDisplayInfo[] {
  return SLOTS.map((slot) => ({
    ...getSlot(slot),
    ...SLOT_DISPLAY[slot],
  }));
}

/**
 * Return the slot that has `modelId` bound, or null if no slot owns it.
 * Replaces the legacy `getLocalModelSlotForModel` from `lib/local-model-routing.ts`.
 */
export function getSlotForModel(modelId: string): Slot | null {
  for (const slot of SLOTS) {
    if (getSlot(slot).modelId === modelId) return slot;
  }
  return null;
}

/**
 * Return true when at least one slot has a model assigned and its status
 * is 'ready'. Replaces the legacy `hasDefaultEligibleLocalModelRoute`.
 */
export function hasReadySlot(): boolean {
  return SLOTS.some((slot) => {
    const state = getSlot(slot);
    return state.model !== null && state.status === 'ready';
  });
}

// ─── Internals ─────────────────────────────────────────────────────────────

function slotKey(slot: Slot): string {
  return KEY_PREFIX + slot;
}

function statusKey(slot: Slot): string {
  return STATUS_KEY_PREFIX + slot;
}

function readSlotId(slot: Slot): string | null {
  const validationOverride = getValidationSlotModelOverride(slot);
  if (validationOverride) return validationOverride;

  const storage = resolveStorage();
  if (!storage) return null;
  const direct = readNonEmpty(storage, slotKey(slot));
  if (direct) return direct;
  // Legacy migration: check the prior keys. On first hit, promote to the
  // new key so subsequent reads skip the fallback.
  for (const prefix of LEGACY_KEY_PREFIXES) {
    const legacy = readNonEmpty(storage, prefix + slot);
    if (legacy) {
      storage.setItem(slotKey(slot), legacy);
      return legacy;
    }
  }
  return null;
}

function readSlotStatus(slot: Slot): SlotStatus {
  const validationOverride = getValidationSlotStatusOverride(slot);
  if (validationOverride) return validationOverride;

  const storage = resolveStorage();
  if (!storage) return 'empty';
  const raw = readNonEmpty(storage, statusKey(slot));
  if (raw === 'preparing' || raw === 'ready' || raw === 'error') return raw;
  return 'empty';
}

function readNonEmpty(storage: KeyValueStorage, key: string): string | null {
  try {
    const value = storage.getItem(key);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Test-only: clear all slot state including legacy keys. */
export function _resetSlotsForTesting(): void {
  injectedStorage = null;
  subscribers.clear();
  const storage = resolveStorage();
  if (!storage) return;
  for (const slot of SLOTS) {
    try {
      storage.removeItem(slotKey(slot));
      storage.removeItem(statusKey(slot));
      for (const prefix of LEGACY_KEY_PREFIXES) {
        storage.removeItem(prefix + slot);
      }
    } catch {
      // Best-effort.
    }
  }
}

/** Returns the legacy key prefixes — exposed for self-heal migration utility. */
export function getLegacyKeyPrefixes(): ReadonlyArray<string> {
  return LEGACY_KEY_PREFIXES;
}

/**
 * Raw persisted slot-id read for the retirement migration ONLY.
 *
 * Unlike `getSlot()`, this does NOT resolve the id against the catalog — it
 * returns whatever id string is persisted, INCLUDING one that has just left
 * the catalog. `getSlot()` nulls a retired id (it resolves to no model), so
 * the retirement migration in self-heal.ts cannot use it to detect a slot
 * still bound to a retired model; this raw read is how it sees that binding.
 *
 * Checks the canonical `eco-local-ai-slot-<slot>` key first, then the legacy
 * `eco-model-slot-*` / `eco-slot-*` keys the old ModelManagement surface wrote.
 * Deliberately READ-ONLY: unlike `readSlotId()`, it does NOT promote a legacy
 * value to the new key — a migration that is about to clear or rebind the slot
 * must not first write the retired id forward. The validation-harness slot
 * override is also ignored: migration acts on persisted user state only.
 */
export function readRawSlotIdForMigration(slot: Slot): string | null {
  const storage = resolveStorage();
  if (!storage) return null;
  const direct = readNonEmpty(storage, slotKey(slot));
  if (direct) return direct;
  for (const prefix of LEGACY_KEY_PREFIXES) {
    const legacy = readNonEmpty(storage, prefix + slot);
    if (legacy) return legacy;
  }
  return null;
}
