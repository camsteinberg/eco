# apps/api -- Eco API Gateway

Hono on Node.js. Entry point for the v1.0 web app's auth and session needs.
Chat inference runs entirely on the user's own device — the API does NOT perform
or proxy inference. Eco is free, so there is no payment processing here either:
server-side billing and the paid tier were removed, along with the subscription
columns they wrote. (The legacy decentralized-inference surface — chat/private/
attestation/network/miner callbacks — was removed in Wave D, as were the GGUF
model registry, governance, devices, impact, and search-proxy routes. The token
economy (`/v1/tokens`), the admin dashboard (`/v1/admin/*`), and the daily-topup
internal endpoint (`/internal/economy`) were removed in Wave D S3a — a
metered token allowance contradicts the v1.0 rule that there are no feature
gates. The user-facing API-key management
route (`/v1/api-keys`) was removed in Wave D S3b — programmatic API keys were
for SDK access to the old network; the v1.0 web app's only client is the
browser authenticating via session cookie. The referral program and the
invite-only signup gate (`/v1/referrals/*`) were removed in Wave D S3b —
referrals belonged to the old network's growth loop, and signup is now open.
The session auth verifier itself is retained as the mechanism guarding the
remaining authenticated routes.)

## Routes

| Path | Method | Purpose |
|------|--------|---------|
| `/v1/auth/profile` | GET/PATCH | User profile |
| `/v1/auth/account` | DELETE | Account deletion |
| `/v1/feedback` | POST | Anonymous in-app feedback (no auth; Origin check + tight `feedback` rate-limit tier) |
| `/v1/search` | POST | Web-search relay to a self-hosted SearXNG instance (no auth; Origin check + `search` tier + a global daily ceiling) |
| `/api/auth/*` | * | Better Auth routes (session cookies, OAuth) |
| `/health` | GET | Health check (DB + Redis probes when configured) |
| `/metrics` | GET | Prometheus metrics — requires `METRICS_TOKEN` bearer auth; disabled (404) in production when `METRICS_TOKEN` is unset |
| `/docs` | GET | Scalar OpenAPI UI (non-production only) |
| `/v1/openapi.json` | GET | OpenAPI 3.1 spec (non-production only) |

## Middleware Stack

Applied in order: body size limit (64 KB on auth/feedback, 4 KB on search) ->
CORS (WEB_URL origins) -> secure headers
(HSTS, CSP, X-Frame-Options) -> request ID propagation (X-Request-Id) ->
request logging (pino) -> rate limiting (Redis fixed-window: tight `auth` tier
on `/api/auth/*`, looser `api` tier on `/v1/*`) -> auth (Better Auth sessions +
API keys).

The custom mutating routes (`PATCH /v1/auth/profile`, `DELETE /v1/auth/account`,
`POST /v1/feedback`, `POST /v1/search`) additionally enforce an
explicit **Origin allowlist** (`createOriginCheck`, same `WEB_URL`-derived origins
as CORS) as CSRF defense-in-depth on top of the session cookie's `SameSite=Lax` —
matching the Origin check the Better Auth `/api/auth/*` routes already do. It
skips GET/HEAD/OPTIONS (so `GET /v1/auth/profile` and preflight are unaffected),
passes when no `Origin` header is present (non-browser clients), and 403s a
present-but-non-allowlisted Origin.

The rate limiter sits after CORS (so OPTIONS preflight is short-circuited and
never counted) and after secure-headers + logging (so a 429 still gets security
headers and is logged), but before the route mounts. It increments
`rate_limit_hits_total{tier}` on each rejection, and returns 429 with
`Retry-After` + `X-RateLimit-*` headers.

**What it keys on.** Three sources, most specific first: `X-Eco-Client-IP` when
it arrives with an `X-Eco-Proxy-Key` matching `API_PROXY_SECRET`
(`timingSafeEqual`, and the value must parse as an IP); then the trusted
`Fly-Client-IP` header; then the TCP peer address for local/dev. The spoofable
`X-Forwarded-For` is still never trusted — nothing in front of this API
authenticates it. `X-Eco-Client-IP` is the one authenticated exception, and it
exists because the web app proxies `/v1/*` server-side
(`apps/web/app/v1/[...path]/route.ts`): without it the API's view of the caller
is the web host's egress address, so every user of a Vercel region shares one
per-IP bucket while a caller hitting the API domain directly gets a private one.
With `API_PROXY_SECRET` unset, or on a key mismatch, or on a malformed IP, the
resolver falls through to `Fly-Client-IP`/peer exactly as before. `/api/auth/*`
is still a plain Next rewrite, so the `auth` tier keeps the shared-bucket
property until that moves too.

When `REDIS_URL` is unset it is a no-op pass-through (local dev/tests/unconfigured
deploy). When Redis is configured but a call fails, it fails CLOSED in production
for the `auth` tier (returns 503) and fails open otherwise.

## Key Environment Variables

- `DATABASE_URL` -- Neon Postgres. Required for auth.
  Auth and account routes are only mounted when this is set.
- `REDIS_URL` -- Upstash Redis. Backs the health readiness probe AND rate
  limiting (a single shared client). When unset, rate limiting is a no-op
  pass-through.
- `RATE_LIMIT_WINDOW_MS` -- Fixed-window length in ms (default `60000`).
- `RATE_LIMIT_AUTH_MAX` -- Max requests/window/client on `/api/auth/*` (default `10`).
- `RATE_LIMIT_API_MAX` -- Max requests/window/client on `/v1/*` (default `100`).
- `API_PROXY_SECRET` -- Shared secret that makes the web app's `X-Eco-Client-IP`
  header trustworthy (see above). Must match the web app's `API_PROXY_SECRET`.
  Unset -> the header is ignored.
- `RATE_LIMIT_FEEDBACK_MAX` -- Max requests/window/client on `POST /v1/feedback`
  (default `5`; its own `feedback` tier on top of the general `api` tier).
- `RATE_LIMIT_SEARCH_MAX` -- Max requests/window/client on `POST /v1/search`
  (default `20`; its own `search` tier on top of the general `api` tier).
- `RATE_LIMIT_SEARCH_DAILY_MAX` -- GLOBAL search requests allowed per UTC day
  across all callers (default `5000`). Over it the route returns 503
  `search_unavailable`. Backed by one Redis key (`ratelimit:search:daily:<date>`),
  incremented and expired in a single atomic `EVAL`. Fails OPEN when Redis is
  unreachable, matching the limiter's non-`auth` tiers.
- `SEARXNG_URL` -- Base URL of the self-hosted SearXNG instance backing
  `POST /v1/search`, e.g. `http://eco-searxng.internal:8080` (Fly private
  networking; the instance has no public address). Config and deploy live in
  `infra/searxng/`. Unset in dev: the route mounts and answers with an empty
  result set. Unset in production: the route is NOT mounted and the gap is logged
  at `error` level -- deliberately NOT a boot failure, so the API can ship before
  the search instance exists.
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
pnpm test         # vitest
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

- Auth and account routes require DATABASE_URL (auth depends on DB).
- Sentry error tracking initialized at startup.
- Graceful shutdown on SIGTERM/SIGINT with 30s force-kill timeout.
