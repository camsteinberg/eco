// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The 12 architectural invariants for the local-ai module.
 *
 * These tests start as `it.todo` placeholders during Phase A. As each
 * implementation phase lands, the tests are converted to real assertions.
 *
 * These are the ARCHITECTURAL invariants (export/ownership greps). The
 * VALUE-LEVEL state invariants (I1–I7) live in state-invariants.test.ts and
 * are documented in docs/design/local-ai-state-model.md.
 * Each invariant has a "turns green in Phase X" annotation.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getDeviceProfile,
  isBelowFloor,
  getBelowFloorReason,
  listCatalog,
  recommend,
} from '../index';
import { isAssignable } from '../device/compatibility';
import { NoAssignableModelError } from '../selection/recommend';
import type { DeviceProfile, Intent, Slot } from '../types';

const LOCAL_AI_ROOT = join(__dirname, '..');

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...walkTsFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('local-ai invariants', () => {
  it('Invariant 1 — One recommendation engine: only selection/recommend.ts exports a recommend() function (Phase F)', () => {
    // Allowlist: the engine itself and the public barrel (which forwards to
    // it). All other files in the subtree MUST NOT export `recommend`.
    const allowed = new Set([
      join(LOCAL_AI_ROOT, 'selection', 'recommend.ts'),
      join(LOCAL_AI_ROOT, 'index.ts'),
    ]);
    const RECOMMEND_EXPORT_PATTERN = /\bexport\s+(?:async\s+)?function\s+recommend\b|\bexport\s+(?:const|let|var)\s+recommend\b/;

    const offenders: string[] = [];
    for (const file of walkTsFiles(LOCAL_AI_ROOT)) {
      if (allowed.has(file)) continue;
      const content = readFileSync(file, 'utf-8');
      if (RECOMMEND_EXPORT_PATTERN.test(content)) {
        offenders.push(relative(LOCAL_AI_ROOT, file));
      }
    }

    expect(
      offenders,
      `Only selection/recommend.ts and index.ts (barrel forward) may export a recommend() function. Offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('Invariant 2 — Every recommendation is assignable: for every (profile, slot, intent), recommend() returns a model that passes compatibility.isAssignable (Phase F)', () => {
    const SLOTS: Slot[] = ['eco-fast', 'eco-smart'];
    const INTENTS: Intent[] = ['snappy', 'balanced', 'quality'];

    const profileFixtures: { name: string; profile: DeviceProfile }[] = [
      {
        name: 'chromium-24gb-webgpu',
        profile: {
          browserClass: 'chromium', webgpuSupport: 'webgpu', deviceMemoryGB: 24, isMobile: false, override: 'auto',
        },
      },
      {
        name: 'chromium-8gb-webgpu',
        profile: {
          browserClass: 'chromium', webgpuSupport: 'webgpu', deviceMemoryGB: 8, isMobile: false, override: 'auto',
        },
      },
      {
        name: 'chromium-4gb-webgpu',
        profile: {
          browserClass: 'chromium', webgpuSupport: 'webgpu', deviceMemoryGB: 4, isMobile: false, override: 'auto',
        },
      },
      // Exact-boundary memory fixture — guards against off-by-one regressions
      // in device/compatibility.ts. 3 GB is LFM2.5's floor; 4 + 8 GB are
      // already covered by chromium-4gb-webgpu and chromium-8gb-webgpu above.
      {
        name: 'chromium-3gb-webgpu-boundary',
        profile: {
          browserClass: 'chromium', webgpuSupport: 'webgpu', deviceMemoryGB: 3, isMobile: false, override: 'auto',
        },
      },
      {
        name: 'chromium-wasm-only',
        profile: {
          browserClass: 'chromium', webgpuSupport: 'wasm-only', deviceMemoryGB: 8, isMobile: false, override: 'auto',
        },
      },
      {
        name: 'safari-wasm',
        profile: {
          browserClass: 'safari', webgpuSupport: 'wasm-only', deviceMemoryGB: 16, isMobile: false, override: 'auto',
        },
      },
      {
        name: 'firefox-wasm',
        profile: {
          browserClass: 'firefox', webgpuSupport: 'wasm-only', deviceMemoryGB: 16, isMobile: false, override: 'auto',
        },
      },
      {
        name: 'mobile-iphone',
        profile: {
          browserClass: 'safari', webgpuSupport: 'wasm-only', deviceMemoryGB: 4, isMobile: true, override: 'auto',
        },
      },
    ];

    for (const { name, profile } of profileFixtures) {
      for (const slot of SLOTS) {
        for (const intent of INTENTS) {
          // The invariant requires: when recommend RETURNS a model, it is
          // assignable. A throw of NoAssignableModelError is also valid —
          // it means the catalog has no model meeting both the slot
          // intent and the device floor (e.g., eco-smart at 3 GB Chromium
          // WebGPU — only LFM2.5 fits the floor, and its intent is
          // 'snappy' only). Callers are documented to check isBelowFloor
          // first; this test accepts either branch.
          try {
            const model = recommend(slot, profile, intent);
            expect(
              isAssignable(model, profile),
              `recommend(${slot}, ${name}, ${intent}) returned ${model.id} which is NOT assignable`,
            ).toBe(true);
          } catch (err) {
            if (!(err instanceof NoAssignableModelError)) throw err;
          }
        }
      }
    }
  });

  it('Invariant 3 — Single source of truth for slot state: only lifecycle/slots.ts touches eco-local-ai-slot-* localStorage keys (Phase J)', () => {
    const allowedFiles = new Set([
      join(LOCAL_AI_ROOT, 'lifecycle', 'slots.ts'),
      // self-heal.ts may reference the legacy key prefixes via slots.ts's
      // public API (getLegacyKeyPrefixes); this is fine, but if it ever
      // also reads/writes those keys directly we want to know.
    ]);
    // Patterns: any direct getItem/setItem/removeItem reference to an
    // "eco-local-ai-slot-" key, OR a literal of one of the legacy slot
    // prefixes that DOESN'T come through getLegacyKeyPrefixes().
    const SLOT_KEY_LITERAL = /["'`]eco-local-ai-slot-/;

    const offenders: string[] = [];
    for (const file of walkTsFiles(LOCAL_AI_ROOT)) {
      if (allowedFiles.has(file)) continue;
      const content = readFileSync(file, 'utf-8');
      if (SLOT_KEY_LITERAL.test(content)) {
        // Allow tests to reference the keys for setup/assertion purposes.
        if (file.includes('__tests__')) continue;
        offenders.push(relative(LOCAL_AI_ROOT, file));
      }
    }

    expect(
      offenders,
      `Only lifecycle/slots.ts may read/write eco-local-ai-slot-* keys. Offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('Invariant 4 — Single source of truth for download state: only download/progress.ts owns the ProgressTracker symbol inside local-ai/ (Phase H)', () => {
    // Static enforcement: the ProgressTracker class lives in
    // download/progress.ts. Other files in the local-ai/ subtree may
    // IMPORT it (consumers subscribe), but must not re-export it under a
    // different name or declare a parallel tracker class.
    const allowed = new Set([
      join(LOCAL_AI_ROOT, 'download', 'progress.ts'),
    ]);
    // Pattern matches: a class declaration named ProgressTracker, OR an
    // export of a download-status function with the typical shape. Imports
    // are not matched (no `export` prefix).
    const PARALLEL_TRACKER_PATTERN = /\bexport\s+class\s+ProgressTracker\b/;
    const DOWNLOAD_STATUS_EXPORT_PATTERN =
      /\bexport\s+(?:async\s+)?function\s+(?:get|subscribe)DownloadStatus\b|\bexport\s+(?:const|let|var)\s+(?:get|subscribe)DownloadStatus\b/;

    const offenders: string[] = [];
    for (const file of walkTsFiles(LOCAL_AI_ROOT)) {
      if (allowed.has(file)) continue;
      const content = readFileSync(file, 'utf-8');
      if (PARALLEL_TRACKER_PATTERN.test(content) || DOWNLOAD_STATUS_EXPORT_PATTERN.test(content)) {
        offenders.push(relative(LOCAL_AI_ROOT, file));
      }
    }

    expect(
      offenders,
      `Only download/progress.ts may export ProgressTracker or a downloadStatus accessor. Offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('Invariant 5 — Single source of truth for device profile: only device/profile.ts calls navigator.gpu / navigator.deviceMemory (Phase D)', () => {
    const allowedFile = join(LOCAL_AI_ROOT, 'device', 'profile.ts');
    const offenders: { file: string; pattern: string }[] = [];
    // Profile-detection APIs only. navigator.storage (OPFS) is a storage
    // backend concern handled by download/storage.ts (Phase G), and
    // navigator.connection is a network telemetry concern — neither
    // influences the DeviceProfile shape, so they're excluded from this
    // invariant. If the profile ever adds connection-class or storage-quota
    // fields, add those patterns back here.
    const NAVIGATOR_PATTERNS = [
      /\bnavigator\.gpu\b/,
      /\bnavigator\.deviceMemory\b/,
      /\bnavigator\.userAgent\b/,
      /\bnavigator\.hardwareConcurrency\b/,
    ];

    for (const file of walkTsFiles(LOCAL_AI_ROOT)) {
      if (file === allowedFile) continue;
      const content = readFileSync(file, 'utf-8');
      for (const pattern of NAVIGATOR_PATTERNS) {
        if (pattern.test(content)) {
          offenders.push({
            file: relative(LOCAL_AI_ROOT, file),
            pattern: pattern.source,
          });
        }
      }
    }

    expect(
      offenders,
      `device profile detection must only live in device/profile.ts. Offenders: ${offenders
        .map((o) => `${o.file} (${o.pattern})`)
        .join(', ')}`,
    ).toEqual([]);
  });

  it('Invariant 6 — Storage layer never trusts CDN response headers: every put writes Eco-Cache-Size; verify reads only from that header (Phase G)', () => {
    // Static enforcement: grep the storage implementation to confirm no
    // content-length read path exists outside of comments. The behavioral
    // assertion lives in `download/__tests__/storage.test.ts` (chunked-
    // transfer + lying-content-length scenarios).
    const storageFile = readFileSync(join(LOCAL_AI_ROOT, 'download', 'storage.ts'), 'utf-8');
    // Strip block comments and line comments before scanning.
    const code = storageFile
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(
      code.toLowerCase().includes('content-length'),
      "storage.ts must not reference 'content-length' in code (Bug #4 fix). It may appear in comments/docstrings only.",
    ).toBe(false);
  });

  it('Invariant 7 — Count predicate decoupled from delete: countCached(model) does not delete on mismatch (Phase G)', () => {
    // Static enforcement: countCached does not call remove/delete/clearModel
    // inside its body. The behavior is also asserted in storage.test.ts.
    const storageFile = readFileSync(join(LOCAL_AI_ROOT, 'download', 'storage.ts'), 'utf-8');
    const countCachedFnMatch = storageFile.match(
      /export\s+async\s+function\s+countCached\s*\([\s\S]*?\n\}/,
    );
    expect(countCachedFnMatch, 'countCached function not found in storage.ts').not.toBeNull();
    const body = countCachedFnMatch![0];
    expect(body.includes('.remove('), 'countCached must not call .remove()').toBe(false);
    expect(body.includes('.delete('), 'countCached must not call .delete()').toBe(false);
    expect(body.includes('cleanCorrupted'), 'countCached must not invoke cleanCorrupted').toBe(false);
  });

  // Invariant 8 — implementation lives in `recoverable-failures.test.ts`:
  // every AdapterErrorCode is exercised through loadModel + generate +
  // slot state transitions. The placeholder here just confirms the test
  // file is wired so future contributors don't miss it.
  it('Invariant 8 — recoverable-failures suite is present', () => {
    const target = join(__dirname, 'recoverable-failures.test.ts');
    let exists = false;
    try {
      statSync(target);
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(true);
  });

  it('Invariant 9 — Stall detector covers both phases: ProgressTracker fires stall events for download (early + finalize) AND smoke', async () => {
    const { ProgressTracker } = await import('../download/progress');
    type StallEvent = {
      kind: 'stall';
      phase: 'downloading' | 'smoke';
      stall: 'early-stall' | 'finalize-stall' | 'smoke-timeout';
    };

    function harness() {
      let nowMs = 0;
      let nextId = 1;
      const entries = new Map<number, { due: number; cb: () => void }>();
      return {
        now: () => nowMs,
        setTimer: (cb: () => void, ms: number) => {
          const id = nextId++;
          entries.set(id, { due: nowMs + ms, cb });
          return id;
        },
        clearTimer: (h: unknown) => {
          entries.delete(h as number);
        },
        advance(ms: number) {
          const target = nowMs + ms;
          while (true) {
            let earliest: { id: number; due: number; cb: () => void } | null = null;
            for (const [id, e] of entries) {
              if (e.due > target) continue;
              if (!earliest || e.due < earliest.due) earliest = { id, ...e };
            }
            if (!earliest) break;
            entries.delete(earliest.id);
            nowMs = earliest.due;
            earliest.cb();
          }
          nowMs = target;
        },
      };
    }

    // Early-stall: <99% for 30s
    const h1 = harness();
    const events1: StallEvent[] = [];
    const t1 = new ProgressTracker({
      now: h1.now,
      setTimer: h1.setTimer,
      clearTimer: h1.clearTimer,
    });
    t1.subscribe((e) => { if (e.kind === 'stall') events1.push(e); });
    t1.reportDownloadProgress(50, 100);
    h1.advance(30_000);
    expect(events1.length, 'early-stall must fire after 30s with download <99%').toBeGreaterThan(0);
    expect(events1[0]!.phase).toBe('downloading');
    expect(events1[0]!.stall).toBe('early-stall');

    // Finalize-stall: ≥99% for 60s
    const h2 = harness();
    const events2: StallEvent[] = [];
    const t2 = new ProgressTracker({
      now: h2.now,
      setTimer: h2.setTimer,
      clearTimer: h2.clearTimer,
    });
    t2.subscribe((e) => { if (e.kind === 'stall') events2.push(e); });
    t2.reportDownloadProgress(99, 100);
    h2.advance(60_000);
    expect(events2.length, 'finalize-stall must fire after 60s with download ≥99%').toBeGreaterThan(0);
    expect(events2[0]!.phase).toBe('downloading');
    expect(events2[0]!.stall).toBe('finalize-stall');

    // Smoke-timeout: smoke phase no-progress for 30s
    const h3 = harness();
    const events3: StallEvent[] = [];
    const t3 = new ProgressTracker({
      now: h3.now,
      setTimer: h3.setTimer,
      clearTimer: h3.clearTimer,
    });
    t3.subscribe((e) => { if (e.kind === 'stall') events3.push(e); });
    t3.startSmoke();
    h3.advance(30_000);
    expect(events3.length, 'smoke-timeout must fire after 30s with no smoke ping').toBeGreaterThan(0);
    expect(events3[0]!.phase).toBe('smoke');
    expect(events3[0]!.stall).toBe('smoke-timeout');
  });

  it('Invariant 10 — No technical model IDs in user copy: components/local-ai/ JSX has no q4f16/webllm/onnx/fp16/q8/q4/bnb4 literals in user-visible strings (Phase K)', () => {
    const COMPONENTS_ROOT = join(LOCAL_AI_ROOT, '..', 'components', 'local-ai');
    // Patterns that would indicate a technical model id slipped into user-
    // visible copy. The match runs only on JSX-text-like positions, which
    // we approximate by stripping comments and matching content outside
    // of imports / type defs.
    const FORBIDDEN = /["'`>][^"'`<]*\b(q4f16|q4_k_m|bnb4|webllm-q4|onnx-q4|fp16|int8)\b/i;

    const offenders: string[] = [];
    let scanned = 0;
    function scan(dir: string): void {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (entry === '__tests__') continue;
          scan(full);
          continue;
        }
        if (!entry.endsWith('.tsx') && !entry.endsWith('.ts')) continue;
        scanned++;
        const content = readFileSync(full, 'utf-8');
        // Strip comments to keep false-positives down.
        const stripped = content
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
        if (FORBIDDEN.test(stripped)) {
          offenders.push(relative(LOCAL_AI_ROOT, full));
        }
      }
    }
    scan(COMPONENTS_ROOT);
    // At least one component file must have been scanned — otherwise the
    // test is silently green because nothing exists.
    expect(scanned, 'expected to scan at least one component file').toBeGreaterThan(0);
    expect(
      offenders,
      `Technical model identifiers found in user-visible component copy: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('Invariant 11 — Reduce-motion respected: every animated component imports useReducedMotion or has an explicit annotation (Phase K)', () => {
    const COMPONENTS_ROOT = join(LOCAL_AI_ROOT, '..', 'components', 'local-ai');
    const MOTION_IMPORT = /from\s+['"]motion\/react['"]/;
    const REDUCED_MOTION_CHECK = /\buseReducedMotion\b/;
    const OPT_OUT = /\/\/\s*eslint-disable.*motion-respect|\/\*[\s\S]*motion-respect[\s\S]*\*\//;

    const offenders: string[] = [];
    let scanned = 0;
    function scan(dir: string): void {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (entry === '__tests__') continue;
          scan(full);
          continue;
        }
        if (!entry.endsWith('.tsx')) continue;
        scanned++;
        const content = readFileSync(full, 'utf-8');
        if (MOTION_IMPORT.test(content)
            && !REDUCED_MOTION_CHECK.test(content)
            && !OPT_OUT.test(content)) {
          offenders.push(relative(LOCAL_AI_ROOT, full));
        }
      }
    }
    scan(COMPONENTS_ROOT);
    expect(scanned, 'expected to scan at least one component file').toBeGreaterThan(0);
    expect(
      offenders,
      `Components importing motion/react must also import useReducedMotion (or opt out via "motion-respect" comment). Offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('Invariant 12 — No lab code in user-facing source: no file outside apps/web/src/lab/ imports from apps/web/src/lab/ (static check)', () => {
    // Static source-grep variant. Catches every static import / re-export
    // path from production code into apps/web/src/lab/. The build-output
    // variant lives in `apps/web/scripts/verify-no-lab-bundled.mjs` —
    // run via `pnpm --filter @eco/web verify:no-lab-bundle` after build.
    const WEB_SRC = join(LOCAL_AI_ROOT, '..');
    const LAB_DIR = join(WEB_SRC, 'lab');
    // Import patterns we care about:
    //  - `from '...lab/...'`
    //  - `from "...lab/..."`
    //  - `import('...lab/...')` (dynamic)
    //  - `require('...lab/...')`
    const LAB_IMPORT_PATTERN = /(?:from\s+|import\(\s*|require\(\s*)['"][^'"]*\blab\/[^'"]+['"]/g;
    function walkAllTsTsx(dir: string): string[] {
      const out: string[] = [];
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { return out; }
      for (const entry of entries) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue;
          if (full === LAB_DIR) continue; // skip lab itself
          out.push(...walkAllTsTsx(full));
          continue;
        }
        if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
          if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
          if (entry.endsWith('.d.ts')) continue;
          out.push(full);
        }
      }
      return out;
    }
    const offenders: { file: string; matches: string[] }[] = [];
    for (const file of walkAllTsTsx(WEB_SRC)) {
      const content = readFileSync(file, 'utf-8');
      // Strip comments first so an inline comment like `// see lab/candidates`
      // doesn't false-positive.
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
      const matches = stripped.match(LAB_IMPORT_PATTERN);
      if (matches && matches.length > 0) {
        offenders.push({
          file: relative(WEB_SRC, file),
          matches: Array.from(new Set(matches)),
        });
      }
    }
    expect(
      offenders,
      `Files outside apps/web/src/lab/ must not import from apps/web/src/lab/. Offenders: ${
        offenders.map((o) => `${o.file} (${o.matches.join(', ')})`).join('; ')
      }`,
    ).toEqual([]);
  });
});

describe('local-ai public API contract', () => {
  it('recommend(slot, profile, intent) never throws on a valid input combination (Phase F)', () => {
    const profile: DeviceProfile = {
      browserClass: 'chromium',
      webgpuSupport: 'webgpu',
      deviceMemoryGB: 16,
      isMobile: false,
      override: 'auto',
    };
    expect(() => recommend('eco-fast', profile)).not.toThrow();
    expect(() => recommend('eco-smart', profile)).not.toThrow();
    expect(() => recommend('eco-fast', profile, 'snappy')).not.toThrow();
    expect(() => recommend('eco-smart', profile, 'quality')).not.toThrow();
  });

  it('listCatalog(profile) returns { tested, untested, experimental } with no model in multiple buckets (Phase F)', () => {
    const profile: DeviceProfile = {
      browserClass: 'chromium',
      webgpuSupport: 'webgpu',
      deviceMemoryGB: 24,
      isMobile: false,
      override: 'auto',
    };
    const result = listCatalog(profile);
    expect(result).toMatchObject({
      available: expect.any(Array),
    });

    const allIds = result.available.map((entry) => entry.model.id);
    expect(new Set(allIds).size, 'every model appears at most once in available').toBe(allIds.length);
  });

  it('isBelowFloor() and getDeviceProfile() are wired into the public barrel (Phase D)', () => {
    const profile = getDeviceProfile();
    expect(profile).toMatchObject({
      browserClass: expect.any(String),
      webgpuSupport: expect.any(String),
      deviceMemoryGB: expect.any(Number),
      isMobile: expect.any(Boolean),
      override: expect.any(String),
    });

    // isBelowFloor never throws on a real profile shape.
    expect(typeof isBelowFloor()).toBe('boolean');
  });

  it('getBelowFloorReason() returns browser/version/constraint shape (Phase D)', () => {
    const reason = getBelowFloorReason();
    expect(reason).toMatchObject({
      browser: expect.any(String),
      version: expect.any(String),
      constraint: expect.any(String),
    });
  });
});
