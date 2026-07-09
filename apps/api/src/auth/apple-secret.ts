// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Apple Sign-In client secret generator.
 *
 * Apple requires a JWT signed with the team's ES256 private key (.p8 file)
 * as the client_secret for OAuth token exchange. This JWT must be regenerated
 * periodically (max 6 months expiry).
 *
 * @see https://developer.apple.com/documentation/sign_in_with_apple/generate_and_validate_tokens
 */

import { importPKCS8, SignJWT } from 'jose'

/**
 * Generate a short-lived Apple client secret JWT.
 *
 * Required env vars:
 * - APPLE_PRIVATE_KEY — Contents of the .p8 key file (including headers)
 * - APPLE_KEY_ID — 10-character key identifier from Apple Developer portal
 * - APPLE_TEAM_ID — 10-character team identifier
 * - APPLE_CLIENT_ID — Services ID (e.g., 'com.eco.web')
 *
 * @returns Signed JWT to use as client_secret in Apple OAuth
 */
export async function generateAppleClientSecret(): Promise<string> {
  const privateKey = process.env.APPLE_PRIVATE_KEY
  const keyId = process.env.APPLE_KEY_ID
  const teamId = process.env.APPLE_TEAM_ID
  const clientId = process.env.APPLE_CLIENT_ID

  if (!privateKey || !keyId || !teamId || !clientId) {
    throw new Error(
      'Apple Sign-In requires APPLE_PRIVATE_KEY, APPLE_KEY_ID, APPLE_TEAM_ID, and APPLE_CLIENT_ID env vars'
    )
  }

  // Apple .p8 keys are PKCS8-encoded EC P-256 private keys
  const key = await importPKCS8(privateKey, 'ES256')

  const now = Math.floor(Date.now() / 1000)
  const sixMonthsInSeconds = 15777000 // ~6 months

  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(teamId)
    .setSubject(clientId)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt(now)
    .setExpirationTime(now + sixMonthsInSeconds)
    .sign(key)
}
