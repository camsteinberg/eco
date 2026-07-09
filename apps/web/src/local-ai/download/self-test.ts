// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Download self-test — an in-app reproduction of the manual DevTools range-fetch
 * probe we used to diagnose the f16-less 2GB download failures (2026-07-01).
 *
 * It issues a few sequential HTTP Range requests against a model file through
 * the same proxy path the real download uses, reading each response BODY via a
 * streaming reader (not just the headers) — because the observed field failure
 * (`Failed to fetch`) is thrown from the body-stream path, not the initial
 * fetch. Each chunk records status, content-range, bytes actually streamed,
 * elapsed ms, and any error, then a plain-language verdict interprets the
 * pattern (works / blocked / slow / server error) so a user can self-diagnose
 * without opening the console.
 *
 * Pure and injectable (`fetcher`, `now`, `signal`) so it's fully unit-tested;
 * the UI in `app/diagnostics/local-ai/` wires it to a button.
 */

import { RANGE_CHUNK_BYTES } from './download';

/** How many sequential chunks to probe by default. */
export const DEFAULT_SELF_TEST_CHUNKS = 3;

/** An error inside this window points at an outright block, not slowness. */
const FAST_FAIL_MS = 5_000;

/**
 * Below this streamed rate a link is too slow to realistically finish a
 * multi-GB model (100 KB/s ≈ >5 h for 2 GB). Tuned for real 32 MiB chunks.
 */
const MIN_OK_RATE_BYTES_PER_MS = 100;

export type SelfTestChunkResult = {
  chunkIndex: number;
  /** The `bytes=start-end` range that was requested. */
  range: string;
  /** HTTP status, when a response was received. */
  status?: number;
  /** The `content-range` response header, when present. */
  contentRange?: string | null;
  /** Bytes actually streamed from the body (partial when a mid-stream error hit). */
  bytesRead: number;
  /** Wall-clock ms for the request + body read. */
  ms: number;
  /** Failure message (network throw, mid-stream error, or non-2xx status). */
  error?: string;
  errorName?: string;
};

export type SelfTestVerdict = {
  kind: 'ok' | 'fast-fail' | 'slow' | 'http-error';
  message: string;
};

export type DownloadSelfTestResult = {
  url: string;
  chunkBytes: number;
  /** Total file size parsed from the first `content-range`, when available. */
  totalBytes: number | null;
  chunks: SelfTestChunkResult[];
  verdict: SelfTestVerdict;
};

export type RunDownloadSelfTestOptions = {
  /** Fully-resolved file URL (proxy path). */
  url: string;
  /** Bytes per range request. Defaults to the real download chunk size. */
  chunkBytes?: number;
  /** Number of sequential chunks to probe. */
  chunks?: number;
  /** Inject fetch (defaults to the bound global). */
  fetcher?: typeof fetch;
  /** Inject the clock — for deterministic tests. */
  now?: () => number;
  signal?: AbortSignal;
};

function defaultNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Parse the total size from a `bytes start-end/total` content-range header. */
function parseContentRangeTotal(header: string | null | undefined): number | null {
  if (!header) return null;
  const match = /\/(\d+)\s*$/.exec(header.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function computeVerdict(chunks: SelfTestChunkResult[]): SelfTestVerdict {
  const errored = chunks.find((c) => c.error != null);
  if (errored) {
    if (errored.status != null && errored.status !== 200 && errored.status !== 206) {
      return {
        kind: 'http-error',
        message: `The model server returned HTTP ${errored.status}. This is a server or routing problem, not your connection.`,
      };
    }
    if (errored.ms < FAST_FAIL_MS) {
      return {
        kind: 'fast-fail',
        message:
          'A chunk failed almost immediately. A firewall, antivirus/proxy, or your network is most likely blocking the download on this device.',
      };
    }
    return {
      kind: 'slow',
      message:
        'A chunk failed only after a long wait. Your connection is very slow, or a time limit was reached before the chunk finished.',
    };
  }

  if (chunks.length > 0) {
    const slowestRate = chunks.reduce(
      (min, c) => Math.min(min, c.bytesRead / Math.max(c.ms, 1)),
      Infinity,
    );
    if (slowestRate < MIN_OK_RATE_BYTES_PER_MS) {
      return {
        kind: 'slow',
        message:
          'All chunks downloaded, but very slowly. Models will still download on this connection — expect it to take a while.',
      };
    }
  }

  return {
    kind: 'ok',
    message: 'All chunks downloaded cleanly. The download path works on this device and connection.',
  };
}

/**
 * Probe the download path with sequential Range requests and return a
 * structured, self-diagnosing result. Stops at the first failed chunk (a dead
 * link won't recover by hammering it).
 */
export async function runDownloadSelfTest(
  opts: RunDownloadSelfTestOptions,
): Promise<DownloadSelfTestResult> {
  const chunkBytes = opts.chunkBytes ?? RANGE_CHUNK_BYTES;
  const chunkCount = opts.chunks ?? DEFAULT_SELF_TEST_CHUNKS;
  // Bind to the global — a native `fetch` called as a method throws
  // Illegal-invocation in-browser (see pitfall-proxy-single-get-timeout).
  const fetcher = opts.fetcher ?? fetch.bind(globalThis);
  const now = opts.now ?? defaultNow;
  const { signal } = opts;

  const chunks: SelfTestChunkResult[] = [];
  let totalBytes: number | null = null;

  for (let i = 0; i < chunkCount; i++) {
    if (signal?.aborted) break;

    const start = i * chunkBytes;
    const end = start + chunkBytes - 1;
    const range = `bytes=${start}-${end}`;
    const chunk: SelfTestChunkResult = { chunkIndex: i, range, bytesRead: 0, ms: 0 };
    const t0 = now();

    try {
      const response = await fetcher(opts.url, {
        signal,
        headers: { Accept: 'application/octet-stream', Range: range },
      });
      chunk.status = response.status;
      chunk.contentRange = response.headers.get('content-range');
      if (totalBytes == null) {
        totalBytes = parseContentRangeTotal(chunk.contentRange);
      }

      // Stream the body so we reproduce mid-stream failures and measure the
      // real transfer, not just header latency.
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunk.bytesRead += value.byteLength;
        }
      }

      if (response.status !== 200 && response.status !== 206) {
        chunk.error = `HTTP ${response.status}`;
      }
    } catch (err) {
      chunk.error = err instanceof Error ? err.message : String(err);
      if (err instanceof Error) chunk.errorName = err.name;
    } finally {
      chunk.ms = Math.round(now() - t0);
    }

    chunks.push(chunk);
    if (chunk.error != null) break;
  }

  return { url: opts.url, chunkBytes, totalBytes, chunks, verdict: computeVerdict(chunks) };
}
