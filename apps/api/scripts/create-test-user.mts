// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

// Quick script to create a test user for local development
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { drizzle } from 'drizzle-orm/neon-http'
import { neon } from '@neondatabase/serverless'
import * as authSchema from '../src/db/schema/auth.js'

const sql = neon(process.env.DATABASE_URL!)
const db = drizzle(sql)
const auth = betterAuth({
  baseURL: 'http://localhost:3001',
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: authSchema.user,
      session: authSchema.session,
      account: authSchema.account,
      verification: authSchema.verification,
    },
  }),
  emailAndPassword: { enabled: true, requireEmailVerification: false },
})

// Clean up any existing test user
await sql`DELETE FROM account WHERE user_id IN (SELECT id FROM "user" WHERE email = ${'test@example.com'})`.catch(() => {})
await sql`DELETE FROM session WHERE user_id IN (SELECT id FROM "user" WHERE email = ${'test@example.com'})`.catch(() => {})
await sql`DELETE FROM "user" WHERE email = ${'test@example.com'}`.catch(() => {})

const ctx = await auth.api.signUpEmail({
  body: { name: 'Test User', email: 'test@example.com', password: 'Test1234!' },
})
console.log('User created:', ctx.user?.id, ctx.user?.email)
console.log('')
console.log('Login credentials:')
console.log('  Email:    test@example.com')
console.log('  Password: Test1234!')
console.log('')
console.log('Go to: http://localhost:3000/sign-in')
