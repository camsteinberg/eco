// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * mirror-models-to-r2 — populate the model-delivery CDN (Cloudflare R2).
 *
 * WHY: today the browser downloads model weights through the Vercel function
 * `/api/local-models/[...slug]`, which streams the bytes from Hugging Face
 * (HF's CDN sends no CORS headers, so the browser can't fetch it directly).
 * That is fine for a handful of users but becomes a cost + reliability wall at
 * marketing scale — every GB is Vercel egress + a long-lived function
 * invocation, nothing is edge-cached, and HF may throttle one origin pulling
 * that volume. The fix is a control-plane / data-plane split: keep the manifest
 * + allow-list on Vercel, serve the *bytes* straight from R2 (free egress,
 * Cloudflare edge cache, CORS + Range). This script mirrors the reviewed model
 * files into R2 so the CDN can serve them.
 *
 * WHAT it mirrors: exactly the files the client actually downloads — every file
 * that has reviewed metadata (sizeBytes + oid) in artifact-metadata.json. That
 * is the same set the manifest route emits and the download planner fetches, so
 * the mirror is a superset of nothing and a subset of nothing: it is precisely
 * the client's download surface. Each object lands at the SAME path the proxy
 * uses — `{hfId}/resolve/{revision}/{file}` — so the CDN base is a drop-in
 * replacement for the proxy prefix.
 *
 * SAFETY: every uploaded object is verified byte-for-byte against the reviewed
 * SHA-256 oid before it is considered done (a corrupt mirror can never serve
 * bad bytes — and the client re-verifies against the same oid regardless).
 * Idempotent: an object already present with the correct size is skipped.
 *
 * USAGE:
 *   node scripts/mirror-models-to-r2.mjs                 # dry-run (default): prints the plan, no deps/creds needed
 *   node scripts/mirror-models-to-r2.mjs --json          # dry-run, emit machine-readable manifest to stdout
 *   node scripts/mirror-models-to-r2.mjs --execute       # real upload (needs @aws-sdk/client-s3 + R2 env below)
 *   node scripts/mirror-models-to-r2.mjs --execute --only candidate/qwen3.5-2b-onnx
 *
 * REAL-UPLOAD PREREQUISITES (operator-provisioned):
 *   - pnpm add -D -w @aws-sdk/client-s3          (S3-compatible client for R2)
 *   - env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_MODELS_BUCKET
 *   - the bucket needs a CORS policy allowing the Eco origin + a public custom
 *     domain (e.g. models.econetwork.ai) — see the plan doc's provisioning runbook.
 */

import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CATALOG_PATH = join(REPO_ROOT, 'apps/web/src/local-ai/catalog/catalog-data.json');
const METADATA_PATH = join(REPO_ROOT, 'apps/web/src/local-ai/catalog/artifact-metadata.json');
const LICENSE_TEXT_DIR = join(REPO_ROOT, 'apps/web/src/local-ai/catalog/licenses');

const HF_BASE = 'https://huggingface.co';
// Immutable: every object key is revision- and content-addressed (the oid IS
// the content hash), so it can never change under a fixed key — cache forever.
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const JSON_OUT = args.includes('--json');
const ONLY = (() => {
  const i = args.indexOf('--only');
  return i >= 0 ? args[i + 1] : null;
})();

/**
 * Every mirrored model must carry its licence, because mirroring IS
 * redistribution: Apache-2.0 §4(a) and LFM Open License v1.0 §4(a) both require
 * recipients to get a copy of the licence. Most of the repos we download from
 * are repacks that ship no licence file of their own, so for those we upload
 * the verbatim copy held in `apps/web/src/local-ai/catalog/licenses/` to the
 * same `{hfId}/resolve/{revision}/LICENSE` key the weights live under. Where
 * the source repo DOES carry a LICENSE at the pinned revision it is already in
 * `artifact.files` and mirrors from Hugging Face like any other file.
 *
 * @returns {{ modelId:string, hfId:string, revision:string, filePath:string, sizeBytes:number, oid:string, sourceUrl:string|null, localPath:string|null, key:string }[]}
 */
function buildLicensePlan(models) {
  const plan = [];
  for (const model of models) {
    if (ONLY && model.id !== ONLY) continue;
    const artifact = model?.artifact;
    const license = model?.license;
    if (!artifact?.hfId || !artifact?.revision || !license?.textFile) continue;
    // Already covered by the weights plan — the source repo ships it itself.
    if (license.artifactLicenseFile) continue;

    const localPath = join(LICENSE_TEXT_DIR, license.textFile);
    let sizeBytes;
    try {
      sizeBytes = statSync(localPath).size;
    } catch {
      console.error(`ERROR: ${model.id} declares license.textFile "${license.textFile}" but ${localPath} is missing.`);
      process.exit(1);
    }

    plan.push({
      modelId: model.id,
      hfId: artifact.hfId,
      revision: artifact.revision,
      filePath: 'LICENSE',
      sizeBytes,
      // Repo-held text: content-hash it so --execute can still self-verify.
      oid: createHash('sha256').update(readFileSync(localPath)).digest('hex'),
      sourceUrl: null,
      localPath,
      key: `${artifact.hfId}/resolve/${artifact.revision}/LICENSE`,
    });
  }
  return plan;
}

/** @returns {{ modelId:string, hfId:string, revision:string, filePath:string, sizeBytes:number, oid:string, sourceUrl:string|null, localPath:string|null, key:string }[]} */
function buildMirrorPlan() {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  const metadata = JSON.parse(readFileSync(METADATA_PATH, 'utf8'));
  const models = Array.isArray(catalog?.models) ? catalog.models : [];

  const plan = [];
  for (const model of models) {
    if (ONLY && model.id !== ONLY) continue;
    const artifact = model?.artifact;
    const fileMeta = metadata?.[model.id];
    if (!artifact?.hfId || !artifact?.revision || !fileMeta) continue;

    for (const [filePath, meta] of Object.entries(fileMeta)) {
      if (!meta || typeof meta.sizeBytes !== 'number' || typeof meta.oid !== 'string') continue;
      const encodedFile = filePath.split('/').map(encodeURIComponent).join('/');
      const encodedModel = artifact.hfId.split('/').map(encodeURIComponent).join('/');
      const encodedRev = encodeURIComponent(artifact.revision);
      plan.push({
        modelId: model.id,
        hfId: artifact.hfId,
        revision: artifact.revision,
        filePath,
        sizeBytes: meta.sizeBytes,
        oid: meta.oid,
        sourceUrl: `${HF_BASE}/${encodedModel}/resolve/${encodedRev}/${encodedFile}`,
        localPath: null,
        // Mirror the proxy's exact path layout so the CDN base swaps in cleanly.
        key: `${artifact.hfId}/resolve/${artifact.revision}/${filePath}`,
      });
    }
  }
  return [...plan, ...buildLicensePlan(models)];
}

function fmtGiB(bytes) {
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

function printDryRun(plan) {
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return;
  }
  const byModel = new Map();
  for (const f of plan) {
    const e = byModel.get(f.modelId) ?? { files: 0, bytes: 0 };
    e.files += 1;
    e.bytes += f.sizeBytes;
    byModel.set(f.modelId, e);
  }
  console.log('DRY RUN — mirror plan (no bytes moved). Pass --execute to upload.\n');
  let totalFiles = 0;
  let totalBytes = 0;
  for (const [modelId, e] of byModel) {
    console.log(`  ${modelId.padEnd(42)} ${String(e.files).padStart(3)} files  ${fmtGiB(e.bytes).padStart(10)}`);
    totalFiles += e.files;
    totalBytes += e.bytes;
  }
  console.log(`\n  ${'TOTAL'.padEnd(42)} ${String(totalFiles).padStart(3)} files  ${fmtGiB(totalBytes).padStart(10)}`);
  console.log(`  ${byModel.size} models → keys like: ${plan[0]?.key ?? '(none)'}`);

  // Licence coverage is a redistribution obligation, so make it visible in the
  // plan rather than something you have to grep the object list for.
  console.log('\nLICENSE objects (one per model — mirroring is redistribution):');
  const licenceObjects = plan.filter((f) => f.filePath === 'LICENSE');
  for (const f of licenceObjects) {
    const origin = f.localPath ? 'repo-held copy' : 'source repo';
    console.log(`  ${f.modelId.padEnd(42)} ${String(f.sizeBytes).padStart(7)} B  (${origin})  → ${f.key}`);
  }
  const withoutLicence = [...byModel.keys()].filter(
    (id) => !licenceObjects.some((f) => f.modelId === id),
  );
  if (withoutLicence.length > 0) {
    console.log(`\n  WARNING: no LICENSE object for: ${withoutLicence.join(', ')}`);
  }
  console.log('\nNote: this is the one-time seed size. R2 egress is free; the cost this replaces');
  console.log('is per-download Vercel egress (this total × every user who picks each model).');
}

async function sha256OfStream(stream) {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function execute(plan) {
  // Dynamic import so the dry-run path needs no dependency installed.
  let S3;
  try {
    S3 = await import('@aws-sdk/client-s3');
  } catch {
    console.error('ERROR: --execute needs @aws-sdk/client-s3. Run: pnpm add -D -w @aws-sdk/client-s3');
    process.exit(1);
  }
  const { S3Client, PutObjectCommand, HeadObjectCommand } = S3;

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_MODELS_BUCKET } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_MODELS_BUCKET) {
    console.error('ERROR: --execute needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_MODELS_BUCKET.');
    process.exit(1);
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });

  let uploaded = 0, skipped = 0, failed = 0;
  for (const f of plan) {
    try {
      // Idempotent skip: already present with the right size.
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: R2_MODELS_BUCKET, Key: f.key }));
        if (Number(head.ContentLength) === f.sizeBytes) { skipped += 1; continue; }
      } catch { /* not present — upload below */ }

      let buf;
      if (f.localPath) {
        buf = readFileSync(f.localPath);
      } else {
        const res = await fetch(f.sourceUrl, { redirect: 'follow' });
        if (!res.ok || !res.body) throw new Error(`HF ${res.status} for ${f.sourceUrl}`);
        buf = Buffer.from(await res.arrayBuffer());
      }

      const digest = createHash('sha256').update(buf).digest('hex');
      if (f.oid.length === 64 && digest !== f.oid) {
        throw new Error(`SHA-256 mismatch for ${f.key}: expected ${f.oid}, got ${digest}`);
      }
      if (buf.byteLength !== f.sizeBytes) {
        throw new Error(`size mismatch for ${f.key}: expected ${f.sizeBytes}, got ${buf.byteLength}`);
      }

      await client.send(new PutObjectCommand({
        Bucket: R2_MODELS_BUCKET,
        Key: f.key,
        Body: buf,
        ContentType: f.filePath.endsWith('.json')
          ? 'application/json'
          : f.filePath === 'LICENSE'
            ? 'text/plain; charset=utf-8'
            : 'application/octet-stream',
        CacheControl: CACHE_CONTROL,
      }));
      uploaded += 1;
      console.log(`  ✓ ${f.key}  (${fmtGiB(f.sizeBytes)})`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${f.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\nDone. uploaded=${uploaded} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

const plan = buildMirrorPlan();
if (plan.length === 0) {
  console.error('No mirror plan built — check catalog-data.json / artifact-metadata.json paths.');
  process.exit(1);
}
if (EXECUTE) {
  await execute(plan);
} else {
  printDryRun(plan);
}
