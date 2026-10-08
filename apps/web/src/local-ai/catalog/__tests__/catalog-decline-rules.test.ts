// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * `compat.declineOn` is validated when the catalog loads.
 *
 * A decline rule removes a model from a device class, so it must name the class
 * (an empty rule would decline everywhere), use only keys the evaluator reads (a
 * typo would silently match nothing), and carry its evidence (`_rationale`), the
 * measurement behind the removal and what would re-admit the model.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import realData from '../catalog-data.json';

const TARGET_ID = 'local/qwen3-0.6b';

/** Load catalog.ts against a copy of the data with TARGET_ID's declineOn replaced. */
async function loadWithDeclineOn(declineOn: unknown): Promise<unknown> {
  const data = structuredClone(realData) as unknown as { models: Array<{ id: string; compat?: Record<string, unknown> }> };
  const entry = data.models.find((m) => m.id === TARGET_ID);
  if (!entry?.compat) throw new Error(`fixture lost ${TARGET_ID}`);
  entry.compat.declineOn = declineOn;
  vi.resetModules();
  vi.doMock('../catalog-data.json', () => ({ default: data }));
  return import('../catalog');
}

afterEach(() => {
  vi.doUnmock('../catalog-data.json');
  vi.resetModules();
});

describe('catalog — compat.declineOn validation', () => {
  it('loads a rule that names a device class and carries its evidence', async () => {
    await expect(loadWithDeclineOn([
      { browserClass: 'firefox', isMobile: false, _rationale: 'measured somewhere' },
    ])).resolves.toBeDefined();
  });

  it('rejects a rule with no _rationale', async () => {
    await expect(loadWithDeclineOn([{ browserClass: 'firefox' }])).rejects.toThrow(/_rationale/);
  });

  it('rejects a rule that names no device field (it would decline everywhere)', async () => {
    await expect(loadWithDeclineOn([{ _rationale: 'why' }])).rejects.toThrow(/declineOn/);
  });

  it('rejects an unknown key', async () => {
    await expect(loadWithDeclineOn([
      { browser: 'safari', _rationale: 'why' },
    ])).rejects.toThrow(/browser/);
  });

  it('rejects a value of the wrong kind', async () => {
    await expect(loadWithDeclineOn([
      { browserClass: 'netscape', _rationale: 'why' },
    ])).rejects.toThrow(/netscape/);
    await expect(loadWithDeclineOn([
      { isMobile: 'no', _rationale: 'why' },
    ])).rejects.toThrow(/isMobile/);
  });

  it('rejects a declineOn that is not an array', async () => {
    await expect(loadWithDeclineOn({ browserClass: 'safari', _rationale: 'why' })).rejects.toThrow(/declineOn/);
  });
});
