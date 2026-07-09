// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { Hono } from 'hono'
import type { Auth } from '../auth/index.js'

export function createAuthRouter(auth: Auth) {
  const router = new Hono()

  router.all('/*', async (c) => {
    const response = await auth.handler(c.req.raw)
    return response
  })

  return router
}
