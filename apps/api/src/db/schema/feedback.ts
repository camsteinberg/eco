// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'

// In-app feedback. Deliberately anonymous: no user id, no IP, no headers —
// only what the person typed plus the device summary they explicitly opted
// into sending (shown to them verbatim before submit). Anyone who wants a
// reply can include contact details in the message text.
export const feedback = pgTable('feedback', {
  id: uuid('id').defaultRandom().primaryKey(),
  message: text('message').notNull(),
  deviceSummary: text('device_summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
