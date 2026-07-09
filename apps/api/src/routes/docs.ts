// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { Hono } from 'hono'
import { apiReference } from '@scalar/hono-api-reference'
import { openApiSpec } from '../openapi.js'

export const docsRouter = new Hono()

// Serve raw OpenAPI JSON
docsRouter.get('/openapi.json', (c) => {
  return c.json(openApiSpec)
})

// Serve Scalar API reference UI
docsRouter.get(
  '/docs',
  apiReference({
    spec: { content: openApiSpec },
    theme: 'default',
    pageTitle: 'Eco API Reference',
  }),
)
