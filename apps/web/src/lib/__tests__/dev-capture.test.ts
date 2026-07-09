// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it } from 'vitest';
import { CAPTURE_FLAG_KEY, isCaptureEnabled, syncCaptureFlagFromUrl } from '../dev-capture';

beforeEach(() => {
  localStorage.clear();
});

describe('isCaptureEnabled', () => {
  it('is off by default', () => {
    expect(isCaptureEnabled('')).toBe(false);
    expect(isCaptureEnabled('?foo=bar')).toBe(false);
  });

  it('turns on with ?eco-capture=1 even before the sticky flag is set', () => {
    expect(isCaptureEnabled('?eco-capture=1')).toBe(true);
  });

  it('honors the sticky flag without a URL param', () => {
    localStorage.setItem(CAPTURE_FLAG_KEY, '1');
    expect(isCaptureEnabled('')).toBe(true);
  });

  it('?eco-capture=0 force-disables even when the sticky flag is set', () => {
    localStorage.setItem(CAPTURE_FLAG_KEY, '1');
    expect(isCaptureEnabled('?eco-capture=0')).toBe(false);
  });

  it('ignores garbage values for the param', () => {
    expect(isCaptureEnabled('?eco-capture=yes')).toBe(false);
    localStorage.setItem(CAPTURE_FLAG_KEY, '1');
    expect(isCaptureEnabled('?eco-capture=yes')).toBe(true);
  });
});

describe('syncCaptureFlagFromUrl', () => {
  it('persists ?eco-capture=1 as the sticky flag', () => {
    syncCaptureFlagFromUrl('?eco-capture=1');
    expect(localStorage.getItem(CAPTURE_FLAG_KEY)).toBe('1');
    expect(isCaptureEnabled('')).toBe(true);
  });

  it('clears the sticky flag on ?eco-capture=0', () => {
    localStorage.setItem(CAPTURE_FLAG_KEY, '1');
    syncCaptureFlagFromUrl('?eco-capture=0');
    expect(localStorage.getItem(CAPTURE_FLAG_KEY)).toBeNull();
  });

  it('leaves the flag untouched without the param', () => {
    localStorage.setItem(CAPTURE_FLAG_KEY, '1');
    syncCaptureFlagFromUrl('?other=1');
    expect(localStorage.getItem(CAPTURE_FLAG_KEY)).toBe('1');
    syncCaptureFlagFromUrl('');
    expect(localStorage.getItem(CAPTURE_FLAG_KEY)).toBe('1');
  });
});
