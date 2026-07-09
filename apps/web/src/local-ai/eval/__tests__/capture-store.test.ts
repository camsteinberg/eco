// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it } from 'vitest';
import type { CapturedFailure } from '../capture';
import {
  clearCaptures,
  exportCaptures,
  importCaptures,
  loadCaptures,
  MAX_CAPTURES,
  removeCapture,
  saveCapture,
} from '../capture-store';

const STORAGE_KEY = 'eco-local-ai-captures-v1';

function makeCapture(overrides?: Partial<CapturedFailure>): CapturedFailure {
  return {
    schemaVersion: 1,
    captureId: 'cap-1',
    capturedAt: '2026-06-11T00:00:00.000Z',
    tags: ['hallucination'],
    note: 'made up a town',
    history: [{ role: 'user', content: 'hi' }],
    historyTruncated: false,
    prompt: 'what is the population of briznor hollow',
    failingOutput: 'Briznor Hollow has 12,400 residents.',
    modelId: 'candidate/qwen3.5-2b-onnx',
    intent: 'quick',
    receipt: null,
    citations: [],
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('saveCapture / loadCaptures', () => {
  it('round-trips a capture', () => {
    saveCapture(makeCapture());
    const loaded = loadCaptures();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(makeCapture());
  });

  it('FIFO-trims at MAX_CAPTURES (oldest evicted)', () => {
    for (let i = 0; i < MAX_CAPTURES + 3; i++) {
      saveCapture(makeCapture({ captureId: `cap-${i}` }));
    }
    const loaded = loadCaptures();
    expect(loaded).toHaveLength(MAX_CAPTURES);
    expect(loaded[0]!.captureId).toBe('cap-3');
    expect(loaded.at(-1)!.captureId).toBe(`cap-${MAX_CAPTURES + 2}`);
  });

  it('self-heals a malformed payload to empty', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(loadCaptures()).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('self-heals a non-array payload to empty', () => {
    localStorage.setItem(STORAGE_KEY, '{"a":1}');
    expect(loadCaptures()).toEqual([]);
  });

  it('filters structurally invalid entries without dropping valid ones', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([makeCapture(), { captureId: 'cap-bad' }, 42]),
    );
    const loaded = loadCaptures();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.captureId).toBe('cap-1');
  });

  it('drops unknown tags but keeps the capture', () => {
    const raw = { ...makeCapture(), tags: ['hallucination', 'wat', 'depth'] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([raw]));
    expect(loadCaptures()[0]!.tags).toEqual(['hallucination', 'depth']);
  });
});

describe('removeCapture / clearCaptures', () => {
  it('removes by id and reports whether it existed', () => {
    saveCapture(makeCapture({ captureId: 'cap-a' }));
    saveCapture(makeCapture({ captureId: 'cap-b' }));
    expect(removeCapture('cap-a')).toBe(true);
    expect(removeCapture('cap-a')).toBe(false);
    expect(loadCaptures().map((c) => c.captureId)).toEqual(['cap-b']);
  });

  it('clears everything', () => {
    saveCapture(makeCapture());
    clearCaptures();
    expect(loadCaptures()).toEqual([]);
  });
});

describe('exportCaptures / importCaptures', () => {
  it('exports a versioned envelope', () => {
    saveCapture(makeCapture());
    const parsed = JSON.parse(exportCaptures()) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(1);
    expect(typeof parsed.dumpedAt).toBe('string');
    expect(parsed.captures).toEqual([makeCapture()]);
  });

  it('imports an exported envelope, deduping by captureId', () => {
    saveCapture(makeCapture({ captureId: 'cap-a' }));
    const dump = JSON.stringify({
      schemaVersion: 1,
      dumpedAt: '2026-06-11T00:00:00.000Z',
      captures: [makeCapture({ captureId: 'cap-a' }), makeCapture({ captureId: 'cap-b' })],
    });
    const result = importCaptures(dump);
    expect(result).toEqual({ imported: 1, skipped: 1 });
    expect(loadCaptures().map((c) => c.captureId)).toEqual(['cap-a', 'cap-b']);
  });

  it('imports a bare array', () => {
    const result = importCaptures(JSON.stringify([makeCapture({ captureId: 'cap-x' })]));
    expect(result).toEqual({ imported: 1, skipped: 0 });
    expect(loadCaptures()).toHaveLength(1);
  });

  it('counts invalid entries as skipped', () => {
    const result = importCaptures(
      JSON.stringify([makeCapture({ captureId: 'cap-ok' }), { junk: true }]),
    );
    expect(result).toEqual({ imported: 1, skipped: 1 });
  });

  it('returns null on unparseable or non-capture json', () => {
    expect(importCaptures('{nope')).toBeNull();
    expect(importCaptures('"a string"')).toBeNull();
    expect(importCaptures('{"schemaVersion":1}')).toBeNull();
  });

  it('FIFO-trims after a large import', () => {
    const captures = Array.from({ length: MAX_CAPTURES + 5 }, (_, i) =>
      makeCapture({ captureId: `cap-i${i}` }),
    );
    const result = importCaptures(JSON.stringify(captures));
    expect(result!.imported).toBe(MAX_CAPTURES + 5);
    expect(loadCaptures()).toHaveLength(MAX_CAPTURES);
  });
});
