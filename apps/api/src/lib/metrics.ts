// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client'

export const register = new Registry()

register.setDefaultLabels({
  service: 'api',
  environment: process.env.NODE_ENV ?? 'development',
})

collectDefaultMetrics({ register })

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'] as const,
  registers: [register],
})

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [register],
})

export const activeStreams = new Gauge({
  name: 'active_streams',
  help: 'Number of active SSE streams',
  registers: [register],
})

export const authFailuresTotal = new Counter({
  name: 'auth_failures_total',
  help: 'Total authentication failures',
  labelNames: ['reason'] as const,
  registers: [register],
})

export const rateLimitHitsTotal = new Counter({
  name: 'rate_limit_hits_total',
  help: 'Total rate limit rejections by tier',
  labelNames: ['tier'] as const,
  registers: [register],
})
