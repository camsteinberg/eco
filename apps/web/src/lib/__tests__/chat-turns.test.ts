// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Tests for buildLocalReadinessFailureV2 — the v1.0 readiness builder.
 *
 * Pins:
 *   - Return shape parity with buildLocalReadinessFailure (so the useChat
 *     caller's updateMessage(localReadiness: ...) block is unchanged).
 *   - Branded display name in `modelName` (Invariant 10 — no technical IDs,
 *     and no raw catalog names either).
 *   - Status mapping: preparing → partial, error → downloaded-needs-test,
 *     empty → not-downloaded.
 */

import { describe, expect, it } from 'vitest';
import { buildLocalReadinessFailureV2, findAutoRetryTarget } from '../chat-turns';
import { getDisplayInfo } from '../../local-ai/display';
import type { SlotState } from '../../local-ai/lifecycle/slots';
import type { ModelConfig } from '../../local-ai/types';

const QWEN3_FRIENDLY: ModelConfig = {
  id: 'local/qwen3-0.6b',
  friendlyName: 'Qwen3',
  vendor: 'Alibaba',
  sizeGB: 0.6,
} as unknown as ModelConfig;

function slot(overrides: Partial<SlotState>): SlotState {
  return {
    slot: 'eco-fast',
    modelId: null,
    model: null,
    status: 'empty',
    ...overrides,
  };
}

describe('buildLocalReadinessFailureV2', () => {
  it('maps preparing status to partial readiness', () => {
    const result = buildLocalReadinessFailureV2({
      slot: slot({ status: 'preparing', model: QWEN3_FRIENDLY, modelId: QWEN3_FRIENDLY.id }),
    });
    expect(result.readinessStatus).toBe('partial');
    expect(result.message).toMatch(/still preparing/i);
  });

  it('maps error status to downloaded-needs-test readiness', () => {
    const result = buildLocalReadinessFailureV2({
      slot: slot({ status: 'error', model: QWEN3_FRIENDLY, modelId: QWEN3_FRIENDLY.id }),
    });
    expect(result.readinessStatus).toBe('downloaded-needs-test');
    expect(result.message).toMatch(/Re-run setup/i);
  });

  it('maps empty status to not-downloaded readiness', () => {
    const result = buildLocalReadinessFailureV2({ slot: slot({ status: 'empty' }) });
    expect(result.readinessStatus).toBe('not-downloaded');
    expect(result.message).toMatch(/one-time setup/i);
  });

  it('presents both on-device slots as the unified "Eco" identity', () => {
    expect(
      buildLocalReadinessFailureV2({ slot: slot({ slot: 'eco-fast', status: 'empty' }) }).slotLabel,
    ).toBe('Eco');
    expect(
      buildLocalReadinessFailureV2({ slot: slot({ slot: 'eco-smart', status: 'empty' }) }).slotLabel,
    ).toBe('Eco');
  });

  it('renders modelName as the branded display name, never a technical id', () => {
    const result = buildLocalReadinessFailureV2({
      slot: slot({ model: QWEN3_FRIENDLY, modelId: QWEN3_FRIENDLY.id, status: 'preparing' }),
    });
    // The same mapping the choice surfaces use — an error card is not the one
    // place a person meets the raw catalog name.
    expect(result.modelName).toBe(
      getDisplayInfo(QWEN3_FRIENDLY.id, QWEN3_FRIENDLY).friendlyName,
    );
    expect(result.modelName).toBe('Eco Compact (Qwen)');
    expect(result.modelName).not.toContain('q4f16');
    expect(result.modelName).not.toContain('local/');
  });

  it('falls back to the slot label when no model is bound', () => {
    const result = buildLocalReadinessFailureV2({
      slot: slot({ slot: 'eco-fast', model: null, modelId: null, status: 'empty' }),
    });
    expect(result.modelName).toBe('Eco');
  });

  it('always carries the slot id (V1 builder made it optional; V2 always knows)', () => {
    const result = buildLocalReadinessFailureV2({
      slot: slot({ slot: 'eco-smart', status: 'preparing' }),
    });
    expect(result.slotId).toBe('eco-smart');
  });
});

describe("findAutoRetryTarget", () => {
  const readinessCard = (id: string, slotId?: "eco-fast" | "eco-smart") => ({
    id,
    role: "assistant",
    status: "error",
    localReadiness: slotId ? { slotId } : {},
  });

  it("targets the last message when it is a readiness card for the ready slot", () => {
    const messages = [
      { id: "u1", role: "user" },
      readinessCard("a1", "eco-smart"),
    ];
    expect(findAutoRetryTarget(messages, "eco-smart")).toBe("a1");
  });

  it("matches any slot when the card recorded none", () => {
    const messages = [{ id: "u1", role: "user" }, readinessCard("a1")];
    expect(findAutoRetryTarget(messages, "eco-fast")).toBe("a1");
  });

  it("returns null when a different slot became ready", () => {
    const messages = [{ id: "u1", role: "user" }, readinessCard("a1", "eco-smart")];
    expect(findAutoRetryTarget(messages, "eco-fast")).toBeNull();
  });

  it("returns null when the conversation has moved past the card", () => {
    const messages = [
      { id: "u1", role: "user" },
      readinessCard("a1", "eco-smart"),
      { id: "u2", role: "user" },
    ];
    expect(findAutoRetryTarget(messages, "eco-smart")).toBeNull();
  });

  it("returns null for an ordinary (non-readiness) error card", () => {
    const messages = [
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant", status: "error" },
    ];
    expect(findAutoRetryTarget(messages, "eco-smart")).toBeNull();
  });

  it("returns null for a healthy last reply and for an empty thread", () => {
    expect(
      findAutoRetryTarget(
        [{ id: "a1", role: "assistant", status: "complete" }],
        "eco-fast",
      ),
    ).toBeNull();
    expect(findAutoRetryTarget([], "eco-fast")).toBeNull();
  });
});
