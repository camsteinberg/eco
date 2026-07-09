// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEcoSetup } from '../useEcoSetup';

describe('useEcoSetup', () => {
  it('does NOT flip to a terminal error from a progress "error" event (no mid-demotion flash)', () => {
    // executeSetup owns terminal status; defaultRunAttempt fires tracker.error()
    // on every intermediate load/smoke failure, so a progress 'error' event must
    // stay informational or the error screen flashes for a frame mid-recovery.
    const { result } = renderHook(() => useEcoSetup());

    act(() => {
      result.current.actions.onProgressEvent({ kind: 'phase', phase: 'error', reason: 'x' });
    });

    expect(result.current.status).toBe('setting-up');
    expect(result.current.errorExhausted).toBe(false);
  });

  it('sets a terminal error via setError(reason, { exhausted: true })', () => {
    const { result } = renderHook(() => useEcoSetup());

    act(() => {
      result.current.actions.setError('boom', { exhausted: true });
    });

    expect(result.current.status).toBe('error');
    expect(result.current.errorExhausted).toBe(true);
    expect(result.current.errorReason).toBe('boom');
  });
});
