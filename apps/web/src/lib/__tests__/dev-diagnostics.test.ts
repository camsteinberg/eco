// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DIAGNOSTICS_FLAG_KEY,
  isDiagnosticsEnabled,
  syncDiagnosticsFlagFromUrl,
} from '../dev-diagnostics';

beforeEach(() => {
  localStorage.clear();
});

describe('isDiagnosticsEnabled', () => {
  it('is off by default', () => {
    expect(isDiagnosticsEnabled('')).toBe(false);
    expect(isDiagnosticsEnabled('?foo=bar')).toBe(false);
  });

  it('turns on with ?eco-diagnostics=1 even before the sticky flag is set', () => {
    expect(isDiagnosticsEnabled('?eco-diagnostics=1')).toBe(true);
  });

  it('honors the sticky flag without a URL param', () => {
    localStorage.setItem(DIAGNOSTICS_FLAG_KEY, '1');
    expect(isDiagnosticsEnabled('')).toBe(true);
  });

  it('honors the sticky flag when only unrelated params are present', () => {
    localStorage.setItem(DIAGNOSTICS_FLAG_KEY, '1');
    expect(isDiagnosticsEnabled('?tab=models')).toBe(true);
  });

  it('?eco-diagnostics=0 force-disables even when the sticky flag is set', () => {
    localStorage.setItem(DIAGNOSTICS_FLAG_KEY, '1');
    expect(isDiagnosticsEnabled('?eco-diagnostics=0')).toBe(false);
  });

  it('ignores garbage values for the param', () => {
    expect(isDiagnosticsEnabled('?eco-diagnostics=yes')).toBe(false);
    localStorage.setItem(DIAGNOSTICS_FLAG_KEY, '1');
    expect(isDiagnosticsEnabled('?eco-diagnostics=yes')).toBe(true);
  });
});

describe('syncDiagnosticsFlagFromUrl', () => {
  it('persists ?eco-diagnostics=1 as the sticky flag', () => {
    syncDiagnosticsFlagFromUrl('?eco-diagnostics=1');
    expect(localStorage.getItem(DIAGNOSTICS_FLAG_KEY)).toBe('1');
    expect(isDiagnosticsEnabled('')).toBe(true);
  });

  it('clears the sticky flag on ?eco-diagnostics=0', () => {
    localStorage.setItem(DIAGNOSTICS_FLAG_KEY, '1');
    syncDiagnosticsFlagFromUrl('?eco-diagnostics=0');
    expect(localStorage.getItem(DIAGNOSTICS_FLAG_KEY)).toBeNull();
  });

  it('leaves the flag untouched without the param', () => {
    localStorage.setItem(DIAGNOSTICS_FLAG_KEY, '1');
    syncDiagnosticsFlagFromUrl('?other=1');
    expect(localStorage.getItem(DIAGNOSTICS_FLAG_KEY)).toBe('1');
    syncDiagnosticsFlagFromUrl('');
    expect(localStorage.getItem(DIAGNOSTICS_FLAG_KEY)).toBe('1');
  });
});
