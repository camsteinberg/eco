// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { createFetchFailureTracker } from '../fetch-failure-tracker';

describe('createFetchFailureTracker', () => {
  it('stays clean while every fetch succeeds', async () => {
    const t = createFetchFailureTracker(async () => new Response('ok', { status: 200 }));
    await t.fetch('https://x/a');
    await t.fetch('https://x/b');
    expect(t.failed).toBe(false);
  });

  it('records a rejected fetch (network down) and still rethrows it', async () => {
    const t = createFetchFailureTracker(async () => { throw new TypeError('Failed to fetch'); });
    await expect(t.fetch('https://x/a')).rejects.toThrow(/Failed to fetch/);
    expect(t.failed).toBe(true);
  });

  it('records a non-OK response (a 404 the loader would swallow as "does not exist")', async () => {
    const t = createFetchFailureTracker(async () => new Response('nope', { status: 404 }));
    const res = await t.fetch('https://x/a');
    expect(res.status).toBe(404);
    expect(t.failed).toBe(true);
  });
});
