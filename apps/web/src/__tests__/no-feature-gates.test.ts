// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

// Free and Supporter have identical functionality (project policy). Membership
// state may only be read in the places that show membership itself; any other
// read is a feature gate and fails this test.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB_ROOT = join(__dirname, '..', '..')
const SCAN_DIRS = ['src', 'app'].map((d) => join(WEB_ROOT, d))
const ALLOWED = new Set([
  'src/hooks/useSupporterMembership.ts',
  'src/lib/supporter-membership.ts',
  'src/components/settings/AccountTab.tsx',
  'src/components/settings/BillingTab.tsx',
])
const GATE_PATTERN = /\b(isSupporter|subscriptionTier|useSupporterMembership)\b/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (name === 'node_modules' || name.startsWith('.')) continue
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$|__tests__/.test(full)) out.push(full)
  }
  return out
}

describe('no feature gates on membership', () => {
  it('membership state is read only where membership is displayed', () => {
    const offenders = SCAN_DIRS.flatMap((d) => walk(d))
      .filter((f) => GATE_PATTERN.test(readFileSync(f, 'utf8')))
      .map((f) => relative(WEB_ROOT, f))
      .filter((f) => !ALLOWED.has(f))
    expect(offenders).toEqual([])
  })
})
