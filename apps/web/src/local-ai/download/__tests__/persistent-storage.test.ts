// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPersistentStorageForTesting,
  requestPersistentStorage,
} from '../persistent-storage';

afterEach(() => {
  _resetPersistentStorageForTesting();
});

describe('requestPersistentStorage', () => {
  it('returns persistent when the browser grants the request', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    await expect(
      requestPersistentStorage({ persisted: async () => false, persist }),
    ).resolves.toBe('persistent');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('returns denied when the browser declines', async () => {
    await expect(
      requestPersistentStorage({ persisted: async () => false, persist: async () => false }),
    ).resolves.toBe('denied');
  });

  it('skips the request entirely when storage is already persistent', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    await expect(
      requestPersistentStorage({ persisted: async () => true, persist }),
    ).resolves.toBe('persistent');
    expect(persist).not.toHaveBeenCalled();
  });

  it('returns unavailable when the Storage API is missing', async () => {
    await expect(requestPersistentStorage(undefined)).resolves.toBe('unavailable');
    _resetPersistentStorageForTesting();
    await expect(requestPersistentStorage({})).resolves.toBe('unavailable');
  });

  it('returns unavailable when the Storage API throws', async () => {
    await expect(
      requestPersistentStorage({
        persist: async () => {
          throw new Error('boom');
        },
      }),
    ).resolves.toBe('unavailable');
  });

  it('memoizes — repeated calls share one browser request', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const manager = { persisted: async () => false, persist };
    await requestPersistentStorage(manager);
    await requestPersistentStorage(manager);
    await requestPersistentStorage(manager);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('memoizes a denial too — the user is never re-prompted in a session', async () => {
    const persist = vi.fn().mockResolvedValue(false);
    const manager = { persisted: async () => false, persist };
    await expect(requestPersistentStorage(manager)).resolves.toBe('denied');
    await expect(requestPersistentStorage(manager)).resolves.toBe('denied');
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
