// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// createAuth must refuse to boot in production without a real secret.
// better-auth decides "production" from NODE_ENV at module load, which vitest
// overrides in-process, so this runs a real child process with the production
// environment — the same thing Fly runs.
const SCRIPT = `
  const { createAuth } = await import(process.argv[1])
  try {
    await createAuth({})
    console.log('BOOTED')
  } catch (err) {
    console.log('REFUSED: ' + (err instanceof Error ? err.message : String(err)))
  }
`

function bootWith(env: Record<string, string>) {
  const entry = fileURLToPath(new URL('../index.ts', import.meta.url))
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', SCRIPT, entry], {
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'production',
      WEB_URL: 'https://econetwork.ai',
      BETTER_AUTH_URL: 'https://api.econetwork.ai',
      ...env,
    },
    encoding: 'utf8',
    timeout: 30_000,
  })
}

describe('createAuth boot gate (production child process)', () => {
  it('refuses to boot when BETTER_AUTH_SECRET is missing', { timeout: 30_000 }, () => {
    const result = bootWith({})
    expect(result.stdout).toMatch(/^REFUSED: .*default secret/im)
    expect(result.stdout).not.toContain('BOOTED')
  })

  it('boots when a real secret is set', { timeout: 30_000 }, () => {
    const result = bootWith({ BETTER_AUTH_SECRET: 'x'.repeat(32) })
    expect(result.stdout).toContain('BOOTED')
  })
})
