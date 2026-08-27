// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForNetworkIfOffline } from '../setup-runner';

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
}

describe('waitForNetworkIfOffline', () => {
  afterEach(() => {
    delete (navigator as { onLine?: boolean }).onLine;
    vi.useRealTimers();
  });

  it('resolves false at once when the device is online', async () => {
    setOnline(true);
    await expect(waitForNetworkIfOffline(1000)).resolves.toBe(false);
  });

  it('resolves true when an offline device comes back', async () => {
    setOnline(false);
    const p = waitForNetworkIfOffline(60_000);
    setOnline(true);
    window.dispatchEvent(new Event('online'));
    await expect(p).resolves.toBe(true);
  });

  it('gives up (false) after the bound', async () => {
    vi.useFakeTimers();
    setOnline(false);
    const p = waitForNetworkIfOffline(5000);
    await vi.advanceTimersByTimeAsync(5001);
    await expect(p).resolves.toBe(false);
  });
});
