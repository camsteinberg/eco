// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Build the local-AI seed evidence snapshot from diagnostics Eval Harness exports.
 *
 * Usage from repo root:
 *   pnpm --filter @eco/web seed:evidence -- \
 *     --eval-export /path/to/eval-export.json \
 *     --out apps/web/src/local-ai/evidence/data/v1-launch-manual-evidence.json
 *
 * The input is the JSON produced by the diagnostics Eval Harness "Export runs"
 * action. Existing calculated backfill records are preserved; benchmark records
 * for matching (modelId, browserClass, deviceClass) keys are refreshed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(SCRIPT_DIR, '..');
const RUNTIME_SNAPSHOT_RELATIVE_PATH = 'src/local-ai/evidence/data/v1-launch-manual-evidence.json';
const SHIPPING_CATALOG_RELATIVE_PATH = 'src/local-ai/catalog/catalog-data.json';
const PRODUCTION_MESSAGE_TOPOLOGY = 'production-user-turn-hints';
const SHIPPING_MODEL_IDS = loadShippingModelIds();

export function parseEvalExport(value) {
  if (Array.isArray(value)) return value;
  if (isObject(value) && Array.isArray(value.runs)) return value.runs;
  throw new Error('expected an Eval Harness export envelope with a runs array, or a bare run array');
}

export function buildBenchmarkRecordsFromRuns(runs, generatedAt = new Date().toISOString()) {
  const buckets = collectRunBuckets(runs);

  const records = [];
  for (const bucket of buckets.values()) {
    const proof = benchmarkProofForBucket(bucket);
    if (!proof) continue;
    const backendPool = bucket.requiresWasmProof ? proof.passedBackends : bucket.runtimeBackends;
    const runtimeBackend = backendPool.length > 0 ? mostCommon(backendPool) : null;

    const firstTokenMs = median(
      bucket.results.map((r) => r.perf.ttftMs).filter(isFiniteNumber),
    );
    const tokensPerSecond = median(
      bucket.results.map((r) => r.perf.tokensPerSec).filter(isFiniteNumber),
    );

    records.push({
      modelId: bucket.modelId,
      browserClass: bucket.browserClass,
      deviceClass: bucket.deviceClass,
      readiness: 'ready',
      source: 'benchmark',
      routingEvidenceFresh: true,
      routingEvidence: {
        runtimeAdapter: mostCommon(bucket.runtimeAdapters),
        ...(runtimeBackend !== null ? { runtimeBackend } : {}),
        readiness: 'ready',
        observedAt: bucket.observedAt,
        benchmark: {
          firstTokenMs,
          tokensPerSecond,
          reliability: proof.smokePasses / bucket.results.length,
        },
      },
      generatedAt,
    });
  }

  return records.sort(compareRecords);
}

export function mergeBenchmarkRecords(
  existingSnapshot,
  benchmarkRecords,
  generatedAt,
  unprovenAttemptedKeys = new Set(),
) {
  const existingRecords = Array.isArray(existingSnapshot?.routingEvidenceReconciliation)
    ? existingSnapshot.routingEvidenceReconciliation
    : [];
  const incoming = new Map(benchmarkRecords.map((record) => [recordKey(record), record]));
  const merged = [];

  for (const record of existingRecords) {
    const key = recordKey(record);
    const benchmark = incoming.get(key);
    if (!isShippingRecord(record)) {
      incoming.delete(key);
      continue;
    }
    if (!benchmark) {
      if (unprovenAttemptedKeys.has(key) && shouldDropUnsafePreservedRecord(record)) {
        continue;
      }
      merged.push(preserveRecordGeneratedAt(record, existingSnapshot));
      continue;
    }
    merged.push(mergeRecord(record, benchmark));
    incoming.delete(key);
  }

  for (const record of incoming.values()) {
    merged.push(record);
  }

  return {
    ...(isObject(existingSnapshot) ? existingSnapshot : {}),
    schemaVersion: Number.isInteger(existingSnapshot?.schemaVersion)
      ? existingSnapshot.schemaVersion
      : 1,
    generatedAt,
    routingEvidenceReconciliation: merged.sort(compareRecords),
  };
}

export function buildSnapshotFromEvalExport(existingSnapshot, evalExport, generatedAt = new Date().toISOString()) {
  const runs = parseEvalExport(evalExport);
  const benchmarkRecords = buildBenchmarkRecordsFromRuns(runs, generatedAt);
  const snapshotGeneratedAt =
    benchmarkRecords.length > 0
      ? generatedAt
      : typeof existingSnapshot?.generatedAt === 'string'
        ? existingSnapshot.generatedAt
        : generatedAt;
  return mergeBenchmarkRecords(
    existingSnapshot,
    benchmarkRecords,
    snapshotGeneratedAt,
    unprovenAttemptedRecordKeysFromRuns(runs),
  );
}

function isShippingRecord(record) {
  return typeof record?.modelId === 'string' && SHIPPING_MODEL_IDS.has(record.modelId);
}

function mergeRecord(existing, benchmark) {
  const existingEvidence = stripStaleMergedEvidence(
    isObject(existing.routingEvidence) ? existing.routingEvidence : {},
  );
  return {
    ...existing,
    ...benchmark,
    ...(typeof existing.name === 'string' ? { name: existing.name } : {}),
    source: 'benchmark',
    routingEvidence: {
      ...existingEvidence,
      ...benchmark.routingEvidence,
      benchmark: benchmark.routingEvidence.benchmark,
      observedAt: benchmark.routingEvidence.observedAt,
    },
  };
}

function preserveRecordGeneratedAt(record, existingSnapshot) {
  if (typeof record.generatedAt === 'string') return record;
  if (isFiniteNumber(record.routingEvidence?.observedAt)) return record;
  if (typeof existingSnapshot?.generatedAt !== 'string') return record;
  return {
    ...record,
    generatedAt: existingSnapshot.generatedAt,
  };
}

function stripStaleMergedEvidence(value) {
  const {
    runtimeBackend: _runtimeBackend,
    recentFailures: _recentFailures,
    failureCode: _failureCode,
    ...rest
  } = value;
  return rest;
}

function collectRunBuckets(runs) {
  const buckets = new Map();

  for (const run of runs) {
    if (!isCompletedRun(run)) continue;
    if (!isProductionTopologyRun(run)) continue;
    const observedAt = parseTime(run.finishedAt) ?? parseTime(run.startedAt);
    if (observedAt === null) continue;

    for (const result of run.results) {
      if (!isObject(result) || typeof result.modelId !== 'string') continue;
      if (!SHIPPING_MODEL_IDS.has(result.modelId)) continue;
      if (!isObject(result.perf)) continue;

      const key = recordKey({
        modelId: result.modelId,
        browserClass: run.device.browserClass,
        deviceClass: run.device.deviceClass,
      });
      const bucket = buckets.get(key) ?? {
        modelId: result.modelId,
        browserClass: run.device.browserClass,
        deviceClass: run.device.deviceClass,
        runtimeAdapters: [],
        runtimeBackends: [],
        requiresWasmProof: isWasmProfile(run.device),
        observedAt,
        results: [],
      };
      bucket.runtimeAdapters.push(
        typeof result.runtimeAdapter === 'string' ? result.runtimeAdapter : 'unknown',
      );
      if (isRuntimeBackend(result.runtimeBackend)) {
        bucket.runtimeBackends.push(result.runtimeBackend);
      }
      bucket.requiresWasmProof = bucket.requiresWasmProof || isWasmProfile(run.device);
      bucket.observedAt = Math.max(bucket.observedAt, observedAt);
      bucket.results.push(result);
      buckets.set(key, bucket);
    }
  }

  return buckets;
}

function benchmarkProofForBucket(bucket) {
  if (bucket.results.length === 0) return null;
  const passedResults = bucket.results.filter((result) => result.perf.smokePass === true);
  if (passedResults.length === 0) return null;
  const passedBackends = passedResults.map((result) => result.runtimeBackend).filter(isRuntimeBackend);
  if (
    bucket.requiresWasmProof
    && (
      passedBackends.length !== passedResults.length
      || passedBackends.some((backend) => backend !== 'wasm')
    )
  ) {
    return null;
  }
  return {
    smokePasses: passedResults.length,
    passedBackends,
  };
}

function unprovenAttemptedRecordKeysFromRuns(runs) {
  const keys = new Set();
  for (const [key, bucket] of collectRunBuckets(runs)) {
    if (bucket.results.length > 0 && !benchmarkProofForBucket(bucket)) {
      keys.add(key);
    }
  }
  return keys;
}

function shouldDropUnsafePreservedRecord(record) {
  if (record?.source === 'calculated') return false;
  if (isWasmProfile(record)) return true;
  return hasFailureSignal(record);
}

function hasFailureSignal(record) {
  if (!isObject(record)) return false;
  if (record.compatibilityState === 'fail') return true;
  if (record.readiness === 'fail' || record.readiness === 'blocked') return true;
  if (typeof record.failureCode === 'string') return true;

  const evidence = isObject(record.routingEvidence) ? record.routingEvidence : {};
  if (typeof evidence.failureCode === 'string') return true;
  const lifecycleProof = isObject(evidence.lifecycleProof) ? evidence.lifecycleProof : {};
  return Object.values(lifecycleProof).some((phase) => isObject(phase) && phase.status === 'fail');
}

function isCompletedRun(value) {
  return (
    isObject(value)
    && value.schemaVersion === 1
    && typeof value.startedAt === 'string'
    && typeof value.finishedAt === 'string'
    && isObject(value.device)
    && typeof value.device.browserClass === 'string'
    && typeof value.device.deviceClass === 'string'
    && Array.isArray(value.results)
  );
}

function isProductionTopologyRun(run) {
  return run.config?.messageTopology === PRODUCTION_MESSAGE_TOPOLOGY;
}

function recordKey(record) {
  return `${String(record.modelId)}\u0000${String(record.browserClass)}\u0000${String(record.deviceClass)}`;
}

function compareRecords(a, b) {
  return recordKey(a).localeCompare(recordKey(b));
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function mostCommon(values) {
  if (values.length === 0) return 'unknown';
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

function parseTime(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRuntimeBackend(value) {
  return value === 'webgpu' || value === 'wasm';
}

function isWasmProfile(device) {
  return device?.webgpuSupport === 'wasm-only' || device?.deviceClass === 'wasm-fallback-laptop';
}

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

export function parseCliArgs(argv) {
  const args = {
    existing: defaultSnapshotPath(),
    out: null,
    evalExport: null,
    generatedAt: new Date().toISOString(),
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--':
        break;
      case '--eval-export':
        args.evalExport = requireValue(argv, ++i, arg);
        break;
      case '--existing':
        args.existing = requireValue(argv, ++i, arg);
        break;
      case '--out':
        args.out = requireValue(argv, ++i, arg);
        break;
      case '--generated-at':
        args.generatedAt = requireValue(argv, ++i, arg);
        if (!Number.isFinite(Date.parse(args.generatedAt))) {
          throw new Error(`--generated-at must be a parseable ISO timestamp, got ${args.generatedAt}`);
        }
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!args.help && !args.evalExport) {
    throw new Error('--eval-export is required');
  }
  return args;
}

function defaultSnapshotPath() {
  return join(WEB_ROOT, RUNTIME_SNAPSHOT_RELATIVE_PATH);
}

function shippingCatalogPath() {
  return join(WEB_ROOT, SHIPPING_CATALOG_RELATIVE_PATH);
}

function loadShippingModelIds() {
  const catalog = JSON.parse(readFileSync(shippingCatalogPath(), 'utf8'));
  if (!Array.isArray(catalog?.models)) {
    throw new Error('shipping catalog must contain a models array');
  }
  return new Set(
    catalog.models
      // catalog-data.json holds BOTH lanes; `shipping: true` is the shipping
      // catalog. Without this filter the dev-only eval candidates would count as
      // shipping models and their rows would be merged into the seed snapshot the
      // app ships — which is what this function exists to prevent.
      .filter((model) => model?.shipping === true)
      .map((model) => (typeof model?.id === 'string' ? model.id : null))
      .filter((modelId) => modelId !== null),
  );
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function printHelp() {
  console.log(`Usage:
  node scripts/build-seed-evidence.mjs --eval-export export.json [options]

Options:
  --existing <path>      Existing seed snapshot. Defaults to the runtime snapshot.
  --out <path>           Output path. Omit or use --dry-run to write JSON to stdout.
  --generated-at <iso>   Snapshot timestamp. Defaults to now.
  --dry-run              Print merged JSON to stdout instead of writing.
`);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const existing = readJson(resolve(args.existing));
  const evalExport = readJson(resolve(args.evalExport));
  const snapshot = buildSnapshotFromEvalExport(existing, evalExport, args.generatedAt);
  const output = `${JSON.stringify(snapshot, null, 2)}\n`;

  if (args.dryRun || !args.out) {
    process.stdout.write(output);
    return;
  }

  writeFileSync(resolve(args.out), output);
}

const isCli = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isCli) {
  main().catch((error) => {
    console.error(`[build-seed-evidence] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
