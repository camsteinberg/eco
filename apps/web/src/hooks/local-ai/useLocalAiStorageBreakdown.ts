// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { useCallback, useEffect, useState } from 'react';
import { getCatalog } from '../../local-ai/catalog/catalog';
import { getDisplayInfo } from '../../local-ai/display';
import {
  CacheApiStorage,
  ECO_PART_MARKER,
  type Storage,
} from '../../local-ai/download/storage';
import type { ModelConfig } from '../../local-ai/types';

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
  /** Branded display name ("Eco Tiny (SmolLM)"), not the raw catalog name. */
  friendlyName: string;
  vendor: string;
  sizeBytes: number;
};

export type StorageBreakdown = {
  browserUsage: number | null;
  browserQuota: number | null;
  ecoTotalBytes: number;
  models: StorageModelEntry[];
  /**
   * False when the Cache API could not even be asked. Zero models with
   * `measured: false` means "we could not check" — never render it as
   * "nothing cached" (gigabytes may well be on disk).
   */
  measured: boolean;
};

export type UseLocalAiStorageBreakdownOptions = {
  /** Inject a Storage backend for tests. Defaults to a fresh CacheApiStorage. */
  storage?: Storage;
  /** Inject the estimate function for tests. */
  estimateBrowserStorage?: () => Promise<StorageEstimate | null>;
  /**
   * Inject the WebLLM-lane measurer for tests. Defaults to the cache bridge's
   * `measureWebllmModelCacheBytes` (lazy-imported so the settings bundle only
   * loads the bridge when it actually measures).
   */
  measureWebllmModel?: (model: ModelConfig) => Promise<number | null>;
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
  const { storage, estimateBrowserStorage, measureWebllmModel, refreshKey } = options;
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
      const breakdown = await computeBreakdown({ storage, estimateBrowserStorage, measureWebllmModel });
      if (cancelled) return;
      setData(breakdown);
      setStatus('ready');
    })();

    return () => {
      cancelled = true;
    };
  }, [storage, estimateBrowserStorage, measureWebllmModel, refreshKey, internalKey]);

  return { status, data, refresh };
}

async function computeBreakdown(opts: {
  storage?: Storage;
  estimateBrowserStorage?: () => Promise<StorageEstimate | null>;
  measureWebllmModel?: (model: ModelConfig) => Promise<number | null>;
}): Promise<StorageBreakdown> {
  const browser = await readBrowserEstimate(opts.estimateBrowserStorage);
  const backend = opts.storage ?? safeCacheApiStorage();
  const measureWebllm = opts.measureWebllmModel ?? defaultMeasureWebllmModel;

  const models: StorageModelEntry[] = [];
  let ecoTotal = 0;

  if (backend) {
    for (const model of getCatalog()) {
      try {
        const entries = dedupePartEntries(await backend.listForModel(model.id));
        let bytes = entries.reduce(
          (sum, entry) => sum + (entry.sizeBytes ?? 0),
          0,
        );
        if (model.runtime === 'webllm') {
          // A webllm model's weights live in WebLLM's own cache namespaces —
          // its Eco namespace is deliberately emptied after staging, so the
          // Eco sweep alone reads a fully-downloaded model as zero bytes.
          const webllmBytes = await measureWebllm(model);
          if (webllmBytes != null) bytes += webllmBytes;
        }
        if (bytes <= 0) continue;
        models.push({
          id: model.id,
          // The catalog's own friendlyName is the raw model name ("SmolLM2
          // 360M"). Primary UI names models the way the rest of the product
          // does, so the storage cards go through the display boundary too.
          friendlyName: getDisplayInfo(model.id, model).friendlyName,
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
    measured: backend != null,
  };
}

/**
 * A completed chunked file exists as BOTH a manifest at its identity URL
 * (stamped with the aggregate size) and every chunk part as its own entry
 * (`<url>.ecopart.<stamp>.<offset>`) — summing everything counts the file
 * twice. Drop a part entry when its identity entry is present; keep orphan
 * parts (mid-download) so partial bytes still show as real usage.
 */
function dedupePartEntries(
  entries: { url: string; sizeBytes: number | null }[],
): { url: string; sizeBytes: number | null }[] {
  const urls = new Set(entries.map((entry) => entry.url));
  return entries.filter((entry) => {
    const marker = entry.url.indexOf(ECO_PART_MARKER);
    if (marker < 0) return true;
    return !urls.has(entry.url.slice(0, marker));
  });
}

async function defaultMeasureWebllmModel(model: ModelConfig): Promise<number | null> {
  try {
    const bridge = await import('../../local-ai/runtime/webllm-cache-bridge');
    return await bridge.measureWebllmModelCacheBytes(model);
  } catch {
    return null;
  }
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
