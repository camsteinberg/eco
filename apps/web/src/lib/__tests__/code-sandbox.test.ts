// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { executeInSandbox } from '../code-sandbox'

const srcRoot = join(process.cwd(), 'src')

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry)
    const stats = statSync(fullPath)
    if (stats.isDirectory()) {
      return listSourceFiles(fullPath)
    }
    return /\.(ts|tsx)$/.test(entry) ? [fullPath] : []
  })
}

describe('executeInSandbox', () => {
  it('rejects unsupported languages with error', async () => {
    const result = await executeInSandbox('x = 1', 'python')
    expect(result.error).toContain('python execution not supported locally')
    expect(result.output).toBe('')
  })

  it('rejects non-js languages', async () => {
    const result = await executeInSandbox('puts "hello"', 'ruby')
    expect(result.error).toContain('ruby execution not supported locally')
  })

  it('disables "javascript" execution without creating a runtime', async () => {
    const result = await executeInSandbox('console.log(2+2)', 'javascript')
    expect(result.output).toBe('')
    expect(result.error).toContain('Local code execution is disabled')
  })

  it('disables "js" execution without creating a runtime', async () => {
    const result = await executeInSandbox('console.log(1)', 'js')
    expect(result.output).toBe('')
    expect(result.error).toContain('Local code execution is disabled')
  })

  it('handles empty JavaScript input by staying disabled', async () => {
    const result = await executeInSandbox('', 'javascript')
    expect(result.output).toBe('')
    expect(result.error).toContain('Local code execution is disabled')
  })

  it('is not imported by launch chat or tool UI surfaces', () => {
    const importers = listSourceFiles(srcRoot)
      .filter((file) => !file.endsWith('src/lib/__tests__/code-sandbox.test.ts'))
      .filter((file) => readFileSync(file, 'utf8').includes('code-sandbox'))
      .map((file) => relative(process.cwd(), file))

    expect(importers).toEqual([])
  })

  it('does not contain Worker or eval runtime execution primitives', () => {
    const source = readFileSync(join(srcRoot, 'lib/code-sandbox.ts'), 'utf8')
    expect(source).not.toMatch(/\bnew\s+Worker\b/)
    expect(source).not.toMatch(/\beval\s*\(/)
    expect(source).not.toMatch(/\bnew\s+Function\b/)
  })
})
