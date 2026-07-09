// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useCallback, useEffect, useState } from 'react';
import { getCatalog } from '../../local-ai/catalog/catalog';
import {
  CacheApiStorage,
  type Storage,
} from '../../local-ai/download/storage';

/**
 * Per-model storage accounting (v7.1).
 *
 * Reads the v1.0 catalog, asks each model's Cache API namespace for its
 * actual cached bytes, and combines that with `navigator.storage.estimate()`
 * so the UI can render a themed storage breakdown:
 *
 *   - browserUsage / browserQuota  → context: how much room remains
 *   - ecoTotalBytes               → sum across all cached eco models
 *   - models                      → per-model byte counts (only > 0)
 *
 * Models whose Cache API namespace is empty are filtered out. The hook is
 * defensive: missing `navigator.storage` or `caches` collapse to null
 * totals + empty models without throwing.
 */

export type StorageModelEntry = {
  id: string;
  friendlyName: string;
  vendor: string;
  sizeBytes: number;
};

export type StorageBreakdown = {
  browserUsage: number | null;
  browserQuota: number | null;
  ecoTotalBytes: number;
  models: StorageModelEntry[];
};

export type UseLocalAiStorageBreakdownOptions = {
  /** Inject a Storage backend for tests. Defaults to a fresh CacheApiStorage. */
  storage?: Storage;
  /** Inject the estimate function for tests. */
  estimateBrowserStorage?: () => Promise<StorageEstimate | null>;
  /** Bump this value to force a recompute (e.g. after clearing a model). */
  refreshKey?: unknown;
};

export type UseLocalAiStorageBreakdownResult = {
  status: 'loading' | 'ready';
  data: StorageBreakdown | null;
  refresh: () => void;
};

export function useLocalAiStorageBreakdown(
  options: UseLocalAiStorageBreakdownOptions = {},
): UseLocalAiStorageBreakdownResult {
  const { storage, estimateBrowserStorage, refreshKey } = options;
  const [data, setData] = useState<StorageBreakdown | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready'>('loading');
  const [internalKey, setInternalKey] = useState(0);

  const refresh = useCallback(() => {
    setInternalKey((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');

    (async () => {
      const breakdown = await computeBreakdown({ storage, estimateBrowserStorage });
      if (cancelled) return;
      setData(breakdown);
      setStatus('ready');
    })();

    return () => {
      cancelled = true;
    };
  }, [storage, estimateBrowserStorage, refreshKey, internalKey]);

  return { status, data, refresh };
}

async function computeBreakdown(opts: {
  storage?: Storage;
  estimateBrowserStorage?: () => Promise<StorageEstimate | null>;
}): Promise<StorageBreakdown> {
  const browser = await readBrowserEstimate(opts.estimateBrowserStorage);
  const backend = opts.storage ?? safeCacheApiStorage();

  const models: StorageModelEntry[] = [];
  let ecoTotal = 0;

  if (backend) {
    for (const model of getCatalog()) {
      try {
        const entries = await backend.listForModel(model.id);
        const bytes = entries.reduce(
          (sum, entry) => sum + (entry.sizeBytes ?? 0),
          0,
        );
        if (bytes <= 0) continue;
        models.push({
          id: model.id,
          friendlyName: model.friendlyName,
          vendor: model.vendor,
          sizeBytes: bytes,
        });
        ecoTotal += bytes;
      } catch {
        // A backend that fails for one model shouldn't mask the others.
      }
    }
  }

  return {
    browserUsage: browser?.usage ?? null,
    browserQuota: browser?.quota ?? null,
    ecoTotalBytes: ecoTotal,
    models,
  };
}

async function readBrowserEstimate(
  inject?: () => Promise<StorageEstimate | null>,
): Promise<StorageEstimate | null> {
  if (inject) {
    try {
      return await inject();
    } catch {
      return null;
    }
  }
  if (typeof navigator === 'undefined') return null;
  const sm = navigator.storage as StorageManager | undefined;
  if (!sm?.estimate) return null;
  try {
    return await sm.estimate();
  } catch {
    return null;
  }
}

function safeCacheApiStorage(): Storage | null {
  if (typeof caches === 'undefined') return null;
  try {
    return new CacheApiStorage();
  } catch {
    return null;
  }
}
