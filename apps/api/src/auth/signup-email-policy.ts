// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Signup email policy — the pure, framework-agnostic half of signup abuse
 * defense (finding #1, pre-flip-hardening-audit-2026-07-06.md).
 *
 * Open signup fires a verification email on every email/password sign-up
 * (`sendOnSignUp` in auth/index.ts). Bot/junk signups to disposable or
 * spam-trap addresses generate bounces and complaints that degrade the
 * sending domain's reputation — which then lands REAL users' password-reset
 * mail in spam. Rejecting known disposable-provider domains BEFORE the account
 * is created (and before the email is sent) removes the cheapest, highest-volume
 * source of that reputational damage.
 *
 * This is one layer, not the whole defense: it does NOT stop a bot using a
 * real-looking domain (random@gmail.com) — that is what the Vercel BotID layer
 * on the signup request is for. The two are complementary: this stops
 * disposable/throwaway domains deterministically; BotID stops automation.
 *
 * Kept pure (no better-auth imports) so it is trivially unit-testable and can
 * be reused from other entry points. The framework-specific rejection (throwing
 * `APIError`) happens at the `hooks.before` wiring site in auth/index.ts.
 *
 * Coverage note: this is a curated set of the highest-volume disposable
 * providers (the ~80/20 that covers most real abuse), deliberately inlined so
 * it is auditable and dependency-free on the auth-critical path. If coverage
 * ever needs to be exhaustive, swap the constant for a maintained data-only
 * list (e.g. the `disposable-email-domains` package) — `isDisposableEmailDomain`
 * is the only call site that would change.
 */

/**
 * Curated disposable / throwaway email provider domains, lowercased. Subdomains
 * of these are matched too (see `isDisposableEmailDomain`), so `foo.mailinator.com`
 * is covered by `mailinator.com`. Keep sorted for reviewability.
 */
const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  '0clickemail.com',
  '10minutemail.com',
  '10minutemail.net',
  '20minutemail.com',
  '33mail.com',
  'armyspy.com',
  'burnermail.io',
  'cuvox.de',
  'dayrep.com',
  'discard.email',
  'dispostable.com',
  'einrot.com',
  'emailondeck.com',
  'fakeinbox.com',
  'fakemailgenerator.com',
  'fleckens.hu',
  'getairmail.com',
  'getnada.com',
  'grr.la',
  'guerrillamail.biz',
  'guerrillamail.com',
  'guerrillamail.de',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'gustr.com',
  'harakirimail.com',
  'inboxkitten.com',
  'jourrapide.com',
  'luxusmail.org',
  'mailcatch.com',
  'maildrop.cc',
  'mailinator.com',
  'mailinator.net',
  'mailnesia.com',
  'mailtemp.net',
  'mintemail.com',
  'moakt.com',
  'mohmal.com',
  'mvrht.com',
  'mytemp.email',
  'nada.email',
  'pokemail.net',
  'rhyta.com',
  'sharklasers.com',
  'spam.la',
  'spam4.me',
  'spamgourmet.com',
  'superrito.com',
  'teleworm.us',
  'temp-mail.org',
  'tempinbox.com',
  'tempmail.com',
  'tempmailo.com',
  'throwawaymail.com',
  'tmail.ws',
  'tmails.net',
  'trashmail.com',
  'trashmail.net',
  'wegwerfmail.de',
  'yopmail.com',
  'yopmail.net',
])

/**
 * Extract the lowercased domain from an email address, or `null` if the input
 * is not a string with a single `@` and a non-empty domain part. Intentionally
 * conservative: we do NOT try to validate full RFC email syntax here (better-auth
 * does its own format validation) — we only need a domain to compare, and a
 * `null` return means "let better-auth's own validator decide", not "reject".
 */
export function extractEmailDomain(email: unknown): string | null {
  if (typeof email !== 'string') return null

  const trimmed = email.trim().toLowerCase()
  const atIndex = trimmed.lastIndexOf('@')
  if (atIndex <= 0 || atIndex === trimmed.length - 1) return null

  const domain = trimmed.slice(atIndex + 1)
  // Reject obviously malformed domains (whitespace, missing dot) by returning
  // null so better-auth's format validator produces its standard message.
  if (!domain.includes('.') || /\s/.test(domain)) return null

  return domain
}

/**
 * Whether the email's domain is a known disposable/throwaway provider. Matches
 * the exact domain and any subdomain of a listed provider.
 */
export function isDisposableEmailDomain(email: unknown): boolean {
  const domain = extractEmailDomain(email)
  if (!domain) return false

  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return true

  for (const blocked of DISPOSABLE_EMAIL_DOMAINS) {
    if (domain.endsWith(`.${blocked}`)) return true
  }

  return false
}

/** User-facing copy for a rejected disposable-domain signup. */
export const DISPOSABLE_EMAIL_REJECTION_MESSAGE =
  'Please use a permanent email address — disposable email providers aren’t supported.'

/**
 * The single decision function the auth hook calls. Returns a user-facing
 * rejection reason if the email must not be allowed to sign up, or `null` if it
 * is acceptable (or if judgment should be deferred to better-auth's own
 * validation — e.g. malformed input). Only disposable domains are rejected here;
 * everything else passes through.
 */
export function getSignupEmailRejectionReason(email: unknown): string | null {
  if (isDisposableEmailDomain(email)) {
    return DISPOSABLE_EMAIL_REJECTION_MESSAGE
  }
  return null
}
