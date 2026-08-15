// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { singleFlightRejection } from '../single-flight';

describe('singleFlightRejection (RT-2 worker single-flight guard)', () => {
  it('lets a generate proceed when the worker is free (no generation in flight)', () => {
    expect(singleFlightRejection(null, 'gen-1')).toBeNull();
  });

  it('rejects an incoming generate while one is already in flight', () => {
    const rejection = singleFlightRejection({ generationId: 'gen-1' }, 'gen-2');
    expect(rejection).not.toBeNull();
    // Tagged with the INCOMING id (gen-2), so the adapter routes the error to
    // the newcomer — NOT to the in-flight gen-1, which must keep running.
    expect(rejection?.generationId).toBe('gen-2');
    expect(rejection?.type).toBe('error');
    expect(rejection?.code).toBe('generation-failed');
    expect(rejection?.message).toMatch(/in progress/i);
  });
});
