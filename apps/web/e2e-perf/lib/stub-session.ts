// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The signed-in session the lanes answer `/api/auth/get-session` with. Shared
 * with the Safari acceptance lane, whose stub api serves the same body from
 * behind the app's own auth proxy.
 */
export const STUB_AUTH_SESSION = {
  session: {
    id: "perf-session",
    userId: "perf-user-id",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  user: {
    id: "perf-user-id",
    email: "perf@eco.network",
    name: "Perf User",
    emailVerified: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
} as const;
