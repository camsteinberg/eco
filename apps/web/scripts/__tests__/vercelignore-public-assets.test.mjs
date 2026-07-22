// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Guards the deploy archive against a whole bug class: a `.vercelignore` pattern
 * that silently strips tracked, servable files under apps/web/public/ from the
 * Vercel upload while local dev keeps working. It has bitten this repo twice —
 * a bare `tools` pattern (fixed by anchoring to `/tools`) and a bare `*.wasm`
 * pattern (fixed by re-including apps/web/public via `!apps/web/public/**`).
 *
 * The next place it would bite is the self-hosted WebLLM/MLC model_lib .wasm the
 * runtime lane will serve from public/: a bare `*.wasm` would strip it and the
 * model would 404 in production only. This test fails the moment any tracked
 * file under apps/web/public/ becomes excluded by `.vercelignore`.
 *
 * The matcher below implements the gitignore semantics `.vercelignore` uses,
 * for the pattern forms this file exercises (bare basename globs, root-anchored
 * paths, directory patterns, and `!` negation). Its self-test asserts it still
 * flags a bare `*.wasm`, so a passing suite is never vacuous.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

function parsePatterns(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((raw) => {
      let negated = false;
      let pattern = raw;
      if (pattern.startsWith('!')) {
        negated = true;
        pattern = pattern.slice(1);
      }
      if (pattern.endsWith('/')) pattern = pattern.slice(0, -1);
      // A slash anywhere (leading or internal) anchors the pattern to the root.
      const anchored = pattern.includes('/');
      if (pattern.startsWith('/')) pattern = pattern.slice(1);
      return { negated, anchored, pattern };
    });
}

function globToRegExpSource(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return source;
}

function patternMatchesPath({ anchored, pattern }, filePath) {
  const source = globToRegExpSource(pattern);
  if (anchored) {
    // Matches the path itself or anything nested beneath a matched directory.
    return new RegExp(`^${source}(/|$)`).test(filePath);
  }
  // Unanchored: matches a basename at any depth (any single path segment).
  const segmentRe = new RegExp(`^${source}$`);
  return filePath.split('/').some((segment) => segmentRe.test(segment));
}

function isExcluded(patterns, filePath) {
  let excluded = false;
  for (const entry of patterns) {
    if (patternMatchesPath(entry, filePath)) {
      excluded = !entry.negated;
    }
  }
  return excluded;
}

function trackedPublicFiles() {
  const output = execFileSync('git', ['ls-files', 'apps/web/public'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return output.split('\n').filter((line) => line.trim() !== '');
}

describe('.vercelignore does not strip servable public assets', () => {
  const vercelignore = readFileSync(path.join(repoRoot, '.vercelignore'), 'utf8');
  const patterns = parsePatterns(vercelignore);
  const publicFiles = trackedPublicFiles();

  it('tracks at least one file under apps/web/public (sanity)', () => {
    expect(publicFiles.length).toBeGreaterThan(0);
  });

  it('excludes no tracked file under apps/web/public', () => {
    const stripped = publicFiles.filter((file) => isExcluded(patterns, file));
    expect(stripped).toEqual([]);
  });

  it('still catches a bare *.wasm that would strip a public binary (non-vacuous)', () => {
    const regressed = parsePatterns('*.wasm');
    expect(isExcluded(regressed, 'apps/web/public/runtimes/webllm/model_lib.wasm')).toBe(true);
    // ...and confirms our own re-include neutralizes exactly that pattern.
    expect(isExcluded(patterns, 'apps/web/public/runtimes/webllm/model_lib.wasm')).toBe(false);
  });
});
