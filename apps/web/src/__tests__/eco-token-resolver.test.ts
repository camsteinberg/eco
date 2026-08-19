// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Scans source files for `var(--eco-…)` references and asserts that every
 * referenced token is defined in the token CSS files. Prevents regressions
 * where components reference custom properties that were never declared,
 * causing browsers to silently drop the rule.
 */

const ROOT = path.resolve(__dirname, "../../../..");
const TOKEN_FILES = [
  path.join(ROOT, "packages/ui/src/tokens/tokens.css"),
  path.join(ROOT, "apps/web/app/globals.css"),
];
const SCAN_DIRS = [
  path.join(ROOT, "apps/web/src"),
  path.join(ROOT, "packages/ui/src"),
];

const VAR_REF_RE = /var\(--eco-([a-z0-9-]+)/g;
const PROP_DEF_RE = /--eco-([a-z0-9-]+)\s*:/g;

function collectFiles(dir: string, exts: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      results.push(...collectFiles(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

function extractMatches(content: string, re: RegExp): Set<string> {
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== undefined) set.add(m[1]);
  }
  return set;
}

describe("eco token resolver guard", () => {
  const definedTokens = new Set<string>();

  for (const tokenFile of TOKEN_FILES) {
    const content = fs.readFileSync(tokenFile, "utf-8");
    for (const name of extractMatches(content, PROP_DEF_RE)) {
      definedTokens.add(name);
    }
  }

  const referencedTokens = new Map<string, string[]>();

  for (const dir of SCAN_DIRS) {
    for (const file of collectFiles(dir, [".tsx", ".ts", ".css"])) {
      const content = fs.readFileSync(file, "utf-8");
      for (const name of extractMatches(content, VAR_REF_RE)) {
        const rel = path.relative(ROOT, file);
        if (!referencedTokens.has(name)) {
          referencedTokens.set(name, []);
        }
        referencedTokens.get(name)!.push(rel);
      }
    }
  }

  it("has at least one defined token (sanity check)", () => {
    expect(definedTokens.size).toBeGreaterThan(0);
  });

  it("has at least one referenced token (sanity check)", () => {
    expect(referencedTokens.size).toBeGreaterThan(0);
  });

  it("every var(--eco-*) reference resolves to a definition in token files", () => {
    const undefined_tokens: Array<{ token: string; files: string[] }> = [];

    for (const [token, files] of referencedTokens) {
      if (!definedTokens.has(token)) {
        const unique = [...new Set(files)];
        undefined_tokens.push({ token: `--eco-${token}`, files: unique });
      }
    }

    if (undefined_tokens.length > 0) {
      const report = undefined_tokens
        .map(
          ({ token, files }) =>
            `  ${token} referenced in:\n${files.map((f) => `    - ${f}`).join("\n")}`,
        )
        .join("\n\n");

      expect.fail(
        `${undefined_tokens.length} --eco-* token(s) referenced but never defined:\n\n${report}`,
      );
    }
  });
});
