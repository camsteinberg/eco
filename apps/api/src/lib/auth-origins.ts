// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

const LOCAL_VALIDATION_ORIGINS = [
  'http://127.0.0.1:3101',
  'http://localhost:3101',
] as const

function splitOriginList(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}

function dedupeOrigins(origins: readonly string[]): string[] {
  return Array.from(new Set(origins))
}

export function getAllowedWebOrigins({
  webUrl = process.env.WEB_URL,
  nodeEnv = process.env.NODE_ENV,
}: {
  webUrl?: string | null
  nodeEnv?: string | null
} = {}): string[] {
  if (nodeEnv === 'production') {
    // Fail closed: never substitute a localhost default in production. A missing
    // WEB_URL on Fly would otherwise silently make the CORS + Better-Auth
    // allowlist `http://localhost:3000` — breaking every browser auth/account/
    // billing call and "trusting" an attacker-reachable localhost. Throwing here
    // gates boot (getAllowedWebOrigins runs at module load in index.ts), so the
    // deploy fails safely — same philosophy as the DB connectivity gate.
    const configuredOrigins = splitOriginList(webUrl)
    if (configuredOrigins.length === 0) {
      throw new Error(
        'WEB_URL must be set in production; refusing to fall back to localhost',
      )
    }
    return dedupeOrigins(configuredOrigins)
  }

  // Non-production keeps the localhost default + local validation fixtures.
  const configuredOrigins = splitOriginList(webUrl ?? 'http://localhost:3000')
  return dedupeOrigins([
    ...configuredOrigins,
    ...LOCAL_VALIDATION_ORIGINS,
  ])
}
