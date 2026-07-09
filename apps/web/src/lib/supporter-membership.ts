// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { sanitizeRelativeUrl } from './auth-continuation'

export const SUPPORTER_BILLING_HREF = '/settings?tab=billing'
export const SUPPORTER_PRICE_MONTHLY_USD = 15

export function isSupporterBillingHref(url: string | null | undefined): boolean {
  return sanitizeRelativeUrl(url, '/chat') === SUPPORTER_BILLING_HREF
}
