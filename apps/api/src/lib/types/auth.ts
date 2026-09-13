// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export type AuthUser = {
  id: string
  email: string
  name: string | null
  /**
   * When the session this request authenticated with was created. Present when
   * the caller came through the session-cookie verifier; absent wherever an
   * `AuthUser` is built without a session behind it. Routes that gate on
   * session freshness must treat `undefined` as "not fresh" — an unknown age is
   * not a young one.
   */
  sessionCreatedAt?: Date
}
