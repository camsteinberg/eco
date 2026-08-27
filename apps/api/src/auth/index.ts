// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { createAuthMiddleware, APIError } from 'better-auth/api'
import { magicLink } from 'better-auth/plugins'
import { Resend } from 'resend'
import type { Db } from '../db/index.js'
import * as authSchema from '../db/schema/auth.js'
import { finalizeNewUser } from './finalize-new-user.js'
import { getAllowedWebOrigins } from '../lib/auth-origins.js'
import { getAuthBaseURL, assertSelfOriginEmailLink } from './email-link-guard.js'
import { escapeHtml } from '../lib/escape-html.js'
import { getSignupEmailRejectionReason } from './signup-email-policy.js'
import { generateAppleClientSecret } from './apple-secret.js'
import { logger } from '../lib/logger.js'

// Gracefully disabled when RESEND_API_KEY is not set
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

// Sender for all transactional mail (reset / verify / magic-link). Defaults to the
// product domain. Override via EMAIL_FROM once the sending domain is verified in Resend
// (DKIM + SPF published). NOTE: this only sets the From address — mail still won't
// authenticate until the chosen domain is DKIM/SPF-verified in Resend + DNS.
const DEFAULT_EMAIL_FROM = 'Eco <noreply@econetwork.ai>'
/** The `from:` address for transactional email; `EMAIL_FROM` env overrides the default. */
export function getEmailFrom(): string {
  return process.env.EMAIL_FROM?.trim() || DEFAULT_EMAIL_FROM
}

/** Resolve the Apple client secret: generate a JWT if all signing inputs are
 *  present, otherwise fall back to the static APPLE_CLIENT_SECRET env var. */
async function resolveAppleClientSecret(): Promise<string> {
  const hasGeneratorInputs =
    !!process.env.APPLE_PRIVATE_KEY &&
    !!process.env.APPLE_KEY_ID &&
    !!process.env.APPLE_TEAM_ID &&
    !!process.env.APPLE_CLIENT_ID
  if (hasGeneratorInputs) {
    try {
      return await generateAppleClientSecret()
    } catch (err) {
      // Generation failed — fall back to the static env var so a
      // misconfigured key doesn't crash boot when Apple is configured.
      logger.warn({ err }, 'Apple client secret generation failed — falling back to APPLE_CLIENT_SECRET env var')
      return process.env.APPLE_CLIENT_SECRET ?? ''
    }
  }
  return process.env.APPLE_CLIENT_SECRET ?? ''
}

export async function createAuth(db: Db) {
  const appleClientSecret = await resolveAppleClientSecret()

  return betterAuth({
    baseURL: getAuthBaseURL(),
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: authSchema.user,
        session: authSchema.session,
        account: authSchema.account,
        verification: authSchema.verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      // Pinned explicitly so the sign-up and reset-password forms' "at least
      // 8 characters" copy can't drift from the server rule on a library bump.
      minPasswordLength: 8,
      // Soft verification, deliberately: verification emails go out on signup
      // (sendOnSignUp below), but sign-in is NOT gated on them. In better-auth
      // 1.6.23, requireEmailVerification also suppresses the session at
      // sign-up (sign-up.mjs: `autoSignIn === false || requireEmailVerification
      // → token: null`), which would strand new users as guests until they
      // verify and break the deploy auth smoke. Email exists for account
      // recovery (password reset), not gating. If strict gating is ever
      // wanted, flip this — the sign-in resend (sendOnSignIn) and the web's
      // EMAIL_NOT_VERIFIED handling are already in place for it.
      requireEmailVerification: false,
      // Account-takeover recovery: resetting the password must kill every
      // existing session, or an attacker who had a session survives the reset.
      // Live-verified gap 2026-06-09: without this, the pre-reset session
      // stayed signed in after the password changed.
      revokeSessionsOnPasswordReset: true,
      ...(resend ? {
        sendResetPassword: async ({ user, url }: { user: { email: string; name: string }; url: string }) => {
          const safeUrl = escapeHtml(assertSelfOriginEmailLink(url))
          await resend.emails.send({
            from: getEmailFrom(),
            to: user.email,
            subject: 'Reset your Eco password',
            html: `
              <div style="font-family: Inter, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
                <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 16px;">Reset your password</h1>
                <p style="color: #666; font-size: 16px; line-height: 1.5;">
                  Hi${user.name ? ` ${escapeHtml(user.name)}` : ''}, we received a request to reset your Eco account password.
                </p>
                <a href="${safeUrl}" style="display: inline-block; margin-top: 24px; padding: 12px 32px; background: #2d5a3d; color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">
                  Reset Password
                </a>
                <p style="color: #999; font-size: 13px; margin-top: 32px;">
                  This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.
                </p>
              </div>
            `,
          })
        },
      } : {}),
    },
    ...(resend ? {
      emailVerification: {
        sendVerificationEmail: async ({ user, url }: { user: { email: string; name: string }; url: string }) => {
          const safeUrl = escapeHtml(assertSelfOriginEmailLink(url))
          await resend.emails.send({
            from: getEmailFrom(),
            to: user.email,
            subject: 'Verify your Eco account',
            html: `
              <div style="font-family: Inter, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
                <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 16px;">Welcome to Eco</h1>
                <p style="color: #666; font-size: 16px; line-height: 1.5;">
                  Hi${user.name ? ` ${escapeHtml(user.name)}` : ''}, click the button below to verify your email address and start using Eco.
                </p>
                <a href="${safeUrl}" style="display: inline-block; margin-top: 24px; padding: 12px 32px; background: #2d5a3d; color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">
                  Verify Email
                </a>
                <p style="color: #999; font-size: 13px; margin-top: 32px;">
                  If you didn't create an Eco account, you can safely ignore this email.
                </p>
              </div>
            `,
          })
        },
        sendOnSignUp: true,
        // Inert today: better-auth only re-sends on sign-in when
        // requireEmailVerification is true (sign-in.mjs), and it is false above
        // — unverified users sign in normally and are never re-sent a link.
        // Kept so flipping requireEmailVerification gives a recovery path; the
        // tight `auth` rate-limit tier bounds how often it could fire.
        sendOnSignIn: true,
      },
    } : {}),
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          if (!resend) return
          const safeUrl = escapeHtml(assertSelfOriginEmailLink(url))
          await resend.emails.send({
            from: getEmailFrom(),
            to: email,
            subject: 'Sign in to Eco',
            html: `
              <div style="font-family: Inter, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
                <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 16px;">Sign in to Eco</h1>
                <p style="color: #666; font-size: 16px; line-height: 1.5;">
                  Click the button below to sign in to your Eco account. No password needed.
                </p>
                <a href="${safeUrl}" style="display: inline-block; margin-top: 24px; padding: 12px 32px; background: #2d5a3d; color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">
                  Sign in to Eco
                </a>
                <p style="color: #999; font-size: 13px; margin-top: 32px;">
                  This link expires in 5 minutes. If you didn't request this, you can safely ignore this email.
                </p>
              </div>
            `,
          })
        },
        expiresIn: 300, // 5 minutes
        disableSignUp: true,
      }),
    ],
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        enabled: !!process.env.GOOGLE_CLIENT_ID,
      },
      github: {
        clientId: process.env.GITHUB_CLIENT_ID ?? '',
        clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
        enabled: !!process.env.GITHUB_CLIENT_ID,
      },
      apple: {
        clientId: process.env.APPLE_CLIENT_ID ?? '',
        clientSecret: appleClientSecret,
        appBundleIdentifier: process.env.APPLE_BUNDLE_ID,
        enabled: !!process.env.APPLE_CLIENT_ID,
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24,       // refresh every 24 hours
    },
    trustedOrigins: [
      ...getAllowedWebOrigins(),
      'https://appleid.apple.com',
    ],
    hooks: {
      // Signup abuse defense (finding #1, pre-flip-hardening-audit-2026-07-06.md):
      // reject disposable/throwaway-provider emails BEFORE the account is created
      // and BEFORE the verification email is sent, so junk signups can't degrade
      // the sending domain's reputation. Scoped to email/password sign-up only —
      // OAuth emails are provider-verified and magic-link signup is disabled, so
      // neither path needs (or should get) this check. The complementary
      // automation defense (Vercel BotID on the signup request) is separate.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-up/email') return
        const rejection = getSignupEmailRejectionReason(ctx.body?.email)
        if (rejection) {
          throw new APIError('BAD_REQUEST', { message: rejection })
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user, context) => {
            await finalizeNewUser({ db, user, context })
          },
        },
      },
    },
    advanced: {
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: true,
        ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
      },
    },
  })
}

export type Auth = Awaited<ReturnType<typeof createAuth>>
