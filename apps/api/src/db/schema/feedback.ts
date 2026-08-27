// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'

// In-app feedback. Deliberately anonymous: no user id, no IP, no headers —
// only what the person typed plus the device summary they explicitly opted
// into sending (shown to them verbatim before submit). Anyone who wants a
// reply can include contact details in the message text.
//
// `failure_summary` is the second opt-in: the last few failure rows from the
// device's local evidence ledger (what failed, which model, error code), shown
// verbatim before submit. Never prompts or replies.
//
// `message`, `device_summary` and `failure_summary` are stored VERBATIM (no HTML sanitization).
// Any future surface that renders them (admin view, export) must treat them
// as untrusted plain text and escape on output — never render as HTML.
export const feedback = pgTable('feedback', {
  id: uuid('id').defaultRandom().primaryKey(),
  message: text('message').notNull(),
  deviceSummary: text('device_summary'),
  failureSummary: text('failure_summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
