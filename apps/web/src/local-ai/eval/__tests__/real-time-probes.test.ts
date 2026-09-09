// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';

import { inferChatIntent } from '../../../lib/chat-intent';
import { detectTool } from '../../../lib/tools';
import {
  REAL_TIME_PROBES,
  REAL_TIME_PROBE_IDS,
  REAL_TIME_SHAPE_BY_ID,
  UNCLAIMED_BY_GROUNDING,
} from '../real-time-probes';

describe('real-time probe set', () => {
  it('is a real set: every entry is real-time, expects a decline, and carries its shape', () => {
    expect(REAL_TIME_PROBES.length).toBeGreaterThanOrEqual(24);
    for (const spec of REAL_TIME_PROBES) {
      expect(spec.category).toBe('real-time');
      expect(spec.prompt.trim().length).toBeGreaterThan(0);
      expect(spec.expectDecline).toBe(true);
      expect(spec.history).toBeUndefined();
      expect(REAL_TIME_SHAPE_BY_ID.get(spec.id)).toBeDefined();
      expect(spec.notes).toContain('Shape:');
    }
  });

  it('covers the three shapes evenly', () => {
    const counts = new Map<string, number>();
    for (const shape of REAL_TIME_SHAPE_BY_ID.values()) counts.set(shape, (counts.get(shape) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual(['live', 'plan', 'sched']);
    for (const n of counts.values()) expect(n).toBe(REAL_TIME_PROBES.length / 3);
  });

  it('has unique rt-prefixed ids that match the exported id set', () => {
    const ids = REAL_TIME_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^rt-(plan|live|sched)-[0-9]+$/);
    expect(REAL_TIME_PROBE_IDS).toEqual(new Set(ids));
  });

  it('keeps intent in lockstep with the live router', () => {
    for (const spec of REAL_TIME_PROBES) {
      expect(spec.intent, `${spec.id} routes differently than its spec.intent`).toBe(
        inferChatIntent(spec.prompt),
      );
    }
  });

  // The seam this set shares with production (see the module comment): the
  // Wikipedia grounding matcher claims most of these prompts, so in production
  // the claimed ones get the "answered from memory" marker and the unclaimed
  // ones get nothing. The split is pinned so a matcher change that moves it
  // also has to move the module comment's account of the seam.
  it('names its seam: the grounding matcher claims every prompt not listed as unclaimed', () => {
    for (const spec of REAL_TIME_PROBES) {
      const detection = detectTool(spec.prompt);
      if (UNCLAIMED_BY_GROUNDING.has(spec.id)) {
        expect(detection, `${spec.id} is now claimed by ${detection?.tool.name ?? "a tool"}`).toBeNull();
      } else {
        expect(detection?.tool.name, `${spec.id} is no longer claimed`).toBe('wikipedia-grounding');
      }
    }
    for (const id of UNCLAIMED_BY_GROUNDING) expect(REAL_TIME_PROBE_IDS.has(id)).toBe(true);
  });
});
