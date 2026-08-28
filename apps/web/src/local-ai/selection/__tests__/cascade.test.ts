// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Phase F — cascade unit tests.
 *
 * Covers:
 *   - nextInCascade returns a different (admitted) model when one fails.
 *   - Repeated failures eventually return null (no infinite fallback).
 *   - excludeIds is honored.
 *   - cascadePath ordering matches listCandidates ordering from recommend.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModel } from '../../catalog/catalog';
import { CURRENT_LEDGER_VERSION, FAILURE_EVIDENCE_VALID_FROM } from '../../evidence/ledger';
import { _resetCascadeTelemetryForTesting, cascadePath, nextInCascade } from '../cascade';
import { listCandidates } from '../recommend';
import type { DeviceProfile } from '../../types';

/** A stable clock safely after the failure-evidence epoch so rows seeded with
 *  `new Date().toISOString()` are never pre-epoch. */
const SAFE_NOW = Date.parse(FAILURE_EVIDENCE_VALID_FROM) + 7 * 24 * 60 * 60 * 1000;

beforeEach(() => {
  _resetCascadeTelemetryForTesting();
  vi.useFakeTimers({ now: SAFE_NOW });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PROFILE_24GB: DeviceProfile = {
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceMemoryGB: 24,
  isMobile: false,
  override: 'auto',
};

const PROFILE_FIREFOX: DeviceProfile = {
  browserClass: 'firefox',
  webgpuSupport: 'wasm-only',
  deviceMemoryGB: 16,
  isMobile: false,
  override: 'auto',
};

describe('nextInCascade', () => {
  it('returns a different admitted model when the recommended one fails', () => {
    const path = cascadePath('eco-fast', PROFILE_24GB);
    expect(path.length).toBeGreaterThan(1);
    const failed = path[0]!;
    const next = nextInCascade(failed, 'eco-fast', PROFILE_24GB);
    expect(next).not.toBeNull();
    expect(next!.id).not.toBe(failed.id);
  });

  it('honors excludeIds — skips previously-failed models', () => {
    const path = cascadePath('eco-fast', PROFILE_24GB);
    expect(path.length).toBeGreaterThan(1);
    const failed = path[0]!;
    const alsoFailed = path[1]!;
    const next = nextInCascade(failed, 'eco-fast', PROFILE_24GB, undefined, {
      excludeIds: [alsoFailed.id],
    });
    if (next) {
      expect(next.id).not.toBe(failed.id);
      expect(next.id).not.toBe(alsoFailed.id);
    }
  });

  it('returns null when the entire cascade has been exhausted', () => {
    const path = cascadePath('eco-fast', PROFILE_FIREFOX);
    const allButLast = path.slice(0, -1).map((m) => m.id);
    const last = path[path.length - 1]!;
    const next = nextInCascade(last, 'eco-fast', PROFILE_FIREFOX, undefined, {
      excludeIds: allButLast,
    });
    expect(next).toBeNull();
  });
});

describe('cascadePath', () => {
  it('matches the listCandidates order from the recommendation engine', () => {
    const path = cascadePath('eco-fast', PROFILE_24GB).map((m) => m.id);
    const ranked = listCandidates('eco-fast', PROFILE_24GB).map((c) => c.model.id);
    expect(path).toEqual(ranked);
  });

  it('returns an empty array on a below-floor profile (no admissible candidates)', () => {
    const belowFloor: DeviceProfile = {
      browserClass: 'unknown',
      webgpuSupport: 'none',
      deviceMemoryGB: 2,
      isMobile: false,
      override: 'auto',
    };
    expect(cascadePath('eco-fast', belowFloor)).toEqual([]);
  });
});

describe('cascadePath — Finding E: WASM cascade never attempts CPU-EP-unloadable models', () => {
  // On a wasm-only device the ladder is the CPU-EP-safe floor set — SmolLM2-360M
  // (preferred fast floor) first, then Granite and qwen3-0.6b. The int4 LFM2.5
  // builds (350m, 1.2B-q4) block-quantize embeddings → GatherBlockQuantized, absent
  // on ort-web's CPU EP, so they must NEVER appear — the setup cascade cannot burn a
  // doomed download on a model that can't load here.
  it('the wasm-only cascade is the CPU-EP-safe floor set, SmolLM2 first, no 350m rung', () => {
    const path = cascadePath('eco-fast', PROFILE_FIREFOX).map((m) => m.id);
    expect(path[0]).toBe('candidate/smollm2-360m-instruct-onnx');
    expect(path).not.toContain('candidate/lfm2.5-350m-onnx');
    expect([...path].sort()).toEqual(
      [
        'candidate/granite-4.0-350m-onnx',
        'candidate/smollm2-360m-instruct-onnx',
        'local/qwen3-0.6b',
      ].sort(),
    );
  });

  it('nextInCascade never yields a CPU-EP-unloadable model on a wasm-only device', () => {
    // Walk the whole ladder from the top; no rung may be a block-quant int4 build.
    let current = cascadePath('eco-fast', PROFILE_FIREFOX)[0]!;
    const visited = [current.id];
    for (let i = 0; i < 5; i++) {
      const next = nextInCascade(current, 'eco-fast', PROFILE_FIREFOX);
      if (!next) break;
      visited.push(next.id);
      current = next;
    }
    expect(visited).not.toContain('candidate/lfm2.5-350m-onnx');
    expect(visited).not.toContain('candidate/lfm2.5-1.2b-instruct-q4-onnx');
  });
});

describe('nextInCascade — synthetic failed model not in catalog', () => {
  it('still returns a real catalog model when the failed argument is exotic', () => {
    const exotic = { ...getModel('candidate/lfm2.5-1.2b-instruct-onnx')!, id: 'lab/exotic' };
    const next = nextInCascade(exotic, 'eco-fast', PROFILE_24GB);
    expect(next).not.toBeNull();
  });
});

describe('nextInCascade — confidence floor enforcement', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('skips models with a recent smoke-fail in the ledger', () => {
    const path = cascadePath('eco-fast', PROFILE_24GB);
    expect(path.length).toBeGreaterThan(1);
    const failed = path[0]!;
    const secondBest = path[1]!;

    // Pre-seed a smoke-fail for the second-best model so it drops out.
    localStorage.setItem(
      'eco-local-ai-ledger-v1',
      JSON.stringify([
        {
          modelId: secondBest.id,
          profileKey: 'chromium|high-memory-laptop|webgpu',
          outcome: 'smoke-fail',
          recordedAt: new Date().toISOString(),
          ledgerVersion: CURRENT_LEDGER_VERSION,
        },
      ]),
    );

    const next = nextInCascade(failed, 'eco-fast', PROFILE_24GB);
    // The cascade should skip the second-best model because it has a failure.
    if (next) {
      expect(next.id).not.toBe(secondBest.id);
    }
  });

  it('cascade path is a subset of the candidate list', () => {
    // Every model in the cascade path must also appear in the candidate
    // list — cascade cannot introduce models that listCandidates filtered.
    const path = cascadePath('eco-fast', PROFILE_24GB);
    const ranked = listCandidates('eco-fast', PROFILE_24GB);
    const candidateIds = new Set(ranked.map((c) => c.model.id));
    for (const model of path) {
      expect(candidateIds.has(model.id), `${model.id} not in candidate list`).toBe(
        true,
      );
    }
  });

  it('preserves exclude-failed-id behavior alongside confidence floor', () => {
    const path = cascadePath('eco-fast', PROFILE_24GB);
    expect(path.length).toBeGreaterThan(1);
    const failed = path[0]!;
    const next = nextInCascade(failed, 'eco-fast', PROFILE_24GB);
    // Basic contract: the cascade never returns the failed model itself.
    expect(next).not.toBeNull();
    expect(next!.id).not.toBe(failed.id);
  });
});

describe('nextInCascade — repeat-failure telemetry', () => {
  it('does not log on the first call for a given failed.id', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const failed = getModel('candidate/lfm2.5-1.2b-instruct-onnx')!;
    nextInCascade(failed, 'eco-fast', PROFILE_24GB);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('logs once via console.debug when called twice with the same failed.id', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const failed = getModel('candidate/lfm2.5-1.2b-instruct-onnx')!;
    nextInCascade(failed, 'eco-fast', PROFILE_24GB);
    nextInCascade(failed, 'eco-fast', PROFILE_24GB);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0]?.[0]).toContain('called twice for failed.id=candidate/lfm2.5-1.2b-instruct-onnx');
  });

  it('keeps cascade selection correct regardless of telemetry state', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const failed = getModel('candidate/lfm2.5-1.2b-instruct-onnx')!;
    const first = nextInCascade(failed, 'eco-fast', PROFILE_24GB);
    const second = nextInCascade(failed, 'eco-fast', PROFILE_24GB);
    expect(first?.id).toBe(second?.id);
    expect(first?.id).not.toBe(failed.id);
  });
});
