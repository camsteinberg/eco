// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(process.env.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty' },
  }),
  base: { service: 'api' },
})
