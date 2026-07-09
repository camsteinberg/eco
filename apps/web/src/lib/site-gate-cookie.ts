// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export const SITE_ACCESS_COOKIE = "eco-site-access";
export const SITE_ACCESS_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const TOKEN_VERSION = "v1";
const SIGNING_ALGORITHM = {
  name: "HMAC",
  hash: "SHA-256",
} as const;

function encodeBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
      Math.ceil(value.length / 4) * 4,
      "=",
    );
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index]! ^ right[index]!;
  }
  return diff === 0;
}

async function importSigningKey(sitePassword: string): Promise<CryptoKey> {
  const keyMaterial = new TextEncoder().encode(`eco-site-gate:${sitePassword}`);
  return crypto.subtle.importKey("raw", keyMaterial, SIGNING_ALGORITHM, false, ["sign"]);
}

async function signPayload(sitePassword: string, payload: string): Promise<Uint8Array> {
  const key = await importSigningKey(sitePassword);
  const signature = await crypto.subtle.sign(
    SIGNING_ALGORITHM,
    key,
    new TextEncoder().encode(payload),
  );
  return new Uint8Array(signature);
}

export async function createSiteGateAccessToken(
  sitePassword: string,
  now: number = Date.now(),
): Promise<string> {
  const expiresAt = now + SITE_ACCESS_COOKIE_MAX_AGE_SECONDS * 1000;
  const payload = `${TOKEN_VERSION}.${expiresAt}`;
  const signature = await signPayload(sitePassword, payload);
  return `${payload}.${encodeBase64Url(signature)}`;
}

export async function isValidSiteGateAccessToken(
  token: string | null | undefined,
  sitePassword: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (!token || !sitePassword) {
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    return false;
  }

  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    return false;
  }

  const suppliedSignature = decodeBase64Url(parts[2]!);
  if (!suppliedSignature) {
    return false;
  }

  const payload = `${parts[0]}.${parts[1]}`;
  const expectedSignature = await signPayload(sitePassword, payload);
  return constantTimeEqual(suppliedSignature, expectedSignature);
}
