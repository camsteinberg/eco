// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';

import { REALISTIC_INPUTS } from '../../../__tests__/fixtures/realistic-inputs';
import { DEFAULT_TOOLS } from '../../../lib/tools';
import {
  DISPATCH_LABELS,
  DISPATCH_NO_TOOL,
  DISPATCH_PROBES,
  DISPATCH_PROBE_IDS,
} from '../dispatch-probes';

describe('dispatch probe set', () => {
  it('is exactly the 50 corpus samples plus the 19 recall phrasings', () => {
    expect(DISPATCH_PROBES).toHaveLength(69);
    expect(REALISTIC_INPUTS).toHaveLength(50);
  });

  it('has unique dispatch-prefixed ids matching the exported id set', () => {
    const ids = DISPATCH_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith('dispatch/')).toBe(true);
    expect(DISPATCH_PROBE_IDS).toEqual(new Set(ids));
  });

  it('carries every corpus sample verbatim', () => {
    const byId = new Map(DISPATCH_PROBES.map((p) => [p.id, p]));
    for (const sample of REALISTIC_INPUTS) {
      expect(byId.get(`dispatch/${sample.id}`)?.prompt).toBe(sample.text);
    }
  });

  it('is entirely in the dispatch category with a non-empty prompt', () => {
    for (const spec of DISPATCH_PROBES) {
      expect(spec.category).toBe('dispatch');
      expect(spec.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it('carries no history: every probe is a single turn', () => {
    for (const spec of DISPATCH_PROBES) expect(spec.history).toBeUndefined();
  });
});

describe('dispatch labels (the frozen key)', () => {
  it('labels every probe and labels nothing else', () => {
    const ids = DISPATCH_PROBES.map((p) => p.id);
    expect(Object.keys(DISPATCH_LABELS).sort()).toEqual([...ids].sort());
  });

  it('only ever names a real registry tool, or NONE', () => {
    const names = new Set(DEFAULT_TOOLS.map((t) => t.name));
    for (const expected of Object.values(DISPATCH_LABELS)) {
      if (expected === DISPATCH_NO_TOOL) continue;
      expect(names.has(expected), `unknown tool label ${expected}`).toBe(true);
    }
  });

  it('derives corpus labels from the corpus fields, not by hand', () => {
    for (const sample of REALISTIC_INPUTS) {
      const expected =
        sample.expectLocalTool ??
        (sample.expectLookup === 'should-look-up' ? 'wikipedia-grounding' : DISPATCH_NO_TOOL);
      expect(DISPATCH_LABELS[`dispatch/${sample.id}`]).toBe(expected);
    }
  });

  it('keeps the NONE guard: the corpus contributes 33 no-tool rows', () => {
    const corpusNone = REALISTIC_INPUTS.filter(
      (s) => DISPATCH_LABELS[`dispatch/${s.id}`] === DISPATCH_NO_TOOL,
    );
    expect(corpusNone).toHaveLength(33);
  });

  it('keeps the recall rows the protocol froze: 19 rows, 6 of them NONE', () => {
    const recall = Object.entries(DISPATCH_LABELS).filter(([id]) =>
      id.startsWith('dispatch/recall-'),
    );
    expect(recall).toHaveLength(19);
    expect(recall.filter(([, v]) => v === DISPATCH_NO_TOOL)).toHaveLength(6);
  });
});
