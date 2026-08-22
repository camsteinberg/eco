# apps/api -- Eco API Gateway

Hono on Node.js. Entry point for the v1.0 web app's account and billing needs.
Chat inference runs entirely on the user's own device — the API does NOT perform
or proxy inference. (The legacy decentralized-inference surface — chat/private/
attestation/network/miner callbacks — was removed in Wave D, as were the GGUF
model registry, governance, devices, impact, and search-proxy routes. The token
economy (`/v1/tokens`), the admin dashboard (`/v1/admin/*`), and the daily-topup
internal endpoint (`/internal/economy`) were removed in Wave D S3a — a
tier-differentiated token allowance contradicts the v1.0 rule that Free and
Supporter have identical functionality. The user-facing API-key management
route (`/v1/api-keys`) was removed in Wave D S3b — programmatic API keys were
for SDK access to the old network; the v1.0 web app's only client is the
browser authenticating via session cookie. The referral program and the
invite-only signup gate (`/v1/referrals/*`) were removed in Wave D S3b —
referrals belonged to the old network's growth loop, and signup is now open
(Free and Supporter have identical functionality). The session/API-key auth
verifier itself is retained as the mechanism guarding the remaining
authenticated routes.)

## Routes

| Path | Method | Purpose |
|------|--------|---------|
| `/v1/billing/checkout` | POST | Stripe checkout session creation |
| `/v1/billing/portal` | POST | Stripe customer portal |
| `/v1/billing/webhook` | POST | Stripe webhook handler (unauthenticated) |
| `/v1/auth/profile` | GET/PATCH | User profile |
| `/v1/auth/account` | DELETE | Account deletion |
| `/v1/feedback` | POST | Anonymous in-app feedback (no auth; Origin check + tight `feedback` rate-limit tier) |
| `/api/auth/*` | * | Better Auth routes (session cookies, OAuth) |
| `/health` | GET | Health check (DB + Redis probes when configured) |
| `/metrics` | GET | Prometheus metrics — requires `METRICS_TOKEN` bearer auth; disabled (404) in production when `METRICS_TOKEN` is unset |
| `/docs` | GET | Scalar OpenAPI UI (non-production only) |
| `/v1/openapi.json` | GET | OpenAPI 3.1 spec (non-production only) |

## Middleware Stack

Applied in order: body size limit (64 KB on billing/auth/feedback) ->
CORS (WEB_URL origins) -> secure headers
(HSTS, CSP, X-Frame-Options) -> request ID propagation (X-Request-Id) ->
request logging (pino) -> rate limiting (Redis fixed-window: tight `auth` tier
on `/api/auth/*`, looser `api` tier on `/v1/*`) -> auth (Better Auth sessions +
API keys).

The custom mutating routes (`PATCH /v1/auth/profile`, `DELETE /v1/auth/account`,
`POST /v1/billing/checkout`, `POST /v1/billing/portal`, `POST /v1/feedback`) additionally enforce an
explicit **Origin allowlist** (`createOriginCheck`, same `WEB_URL`-derived origins
as CORS) as CSRF defense-in-depth on top of the session cookie's `SameSite=Lax` —
matching the Origin check the Better Auth `/api/auth/*` routes already do. It
skips GET/HEAD/OPTIONS (so `GET /v1/auth/profile` and preflight are unaffected),
passes when no `Origin` header is present (non-browser clients), and 403s a
present-but-non-allowlisted Origin. `POST /v1/billing/webhook` is deliberately
excluded (Stripe server-to-server call, signature-verified instead).

The rate limiter sits after CORS (so OPTIONS preflight is short-circuited and
never counted) and after secure-headers + logging (so a 429 still gets security
headers and is logged), but before the route mounts. It keys on the trusted
`Fly-Client-IP` header (falling back to the TCP peer address for local/dev —
never the spoofable `X-Forwarded-For`), increments `rate_limit_hits_total{tier}`
on each rejection, and returns 429 with `Retry-After` + `X-RateLimit-*` headers.
When `REDIS_URL` is unset it is a no-op pass-through (local dev/tests/unconfigured
deploy). When Redis is configured but a call fails, it fails CLOSED in production
for the `auth` tier (returns 503) and fails open otherwise.

## Key Environment Variables

- `DATABASE_URL` -- Neon Postgres. Required for auth.
  Auth, account, and billing routes are only mounted when this is set.
- `REDIS_URL` -- Upstash Redis. Backs the health readiness probe AND rate
  limiting (a single shared client). When unset, rate limiting is a no-op
  pass-through.
- `RATE_LIMIT_WINDOW_MS` -- Fixed-window length in ms (default `60000`).
- `RATE_LIMIT_AUTH_MAX` -- Max requests/window/client on `/api/auth/*` (default `10`).
- `RATE_LIMIT_API_MAX` -- Max requests/window/client on `/v1/*` (default `100`).
- `RATE_LIMIT_FEEDBACK_MAX` -- Max requests/window/client on `POST /v1/feedback`
  (default `5`; its own `feedback` tier on top of the general `api` tier).
- `STRIPE_SECRET_KEY` -- Enables billing routes. Gracefully disabled when unset.
- `STRIPE_WEBHOOK_SECRET` -- Webhook signature verification.
- `METRICS_TOKEN` -- Bearer token required to scrape `/metrics` (timing-safe
  compared). When unset, `/metrics` is open in dev and disabled (404) in
  production (fail closed). Prometheus scrapers must send
  `Authorization: Bearer <METRICS_TOKEN>`.
- `WEB_URL` -- Comma-separated allowed CORS + Origin-check + Better-Auth
  `trustedOrigins` allowlist. **Required in production: fails closed** — if unset
  in prod, `getAllowedWebOrigins()` throws at module load and the boot fails (the
  deploy fails safely) rather than silently falling back to `http://localhost:3000`.
  Outside production it defaults to `http://localhost:3000` (plus local validation
  fixtures).
- `LOG_LEVEL` -- pino log level (default `info`).
- `PORT` -- HTTP port (default `3001`).

## Dev Commands

```bash
pnpm dev          # tsx watch -- hot reload (port 3001)
pnpm build        # tsc compile to dist/
pnpm test         # vitest (~401 tests)
pnpm lint         # eslint
pnpm type-check   # tsc --noEmit
pnpm db:generate  # drizzle-kit generate migration files
pnpm db:migrate   # run pending migrations
pnpm db:push      # push schema directly (dev only)
```

## Database

Drizzle ORM with Neon Postgres. The runtime uses the **serverless WebSocket pool**
driver (`drizzle-orm/neon-serverless`) — this is an always-on Fly Node process and needs
real transaction support, which the stateless `neon-http` driver lacks (it throws on
`db.transaction()`, which 500'd account-delete + profile-update in prod). Local dev uses
`postgres-js`. A fail-fast startup probe (`src/index.ts`) gates the boot on the runtime
driver actually connecting. Schema in `src/db/schema/`.

## Production

Docker multi-stage image deployed on Fly.io (`eco-api`, `eco-api-staging`).

## Important Notes

- Auth/account/billing routes require DATABASE_URL (auth depends on DB).
- Sentry error tracking initialized at startup.
- Graceful shutdown on SIGTERM/SIGINT with 30s force-kill timeout.
