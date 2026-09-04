# Eco — Contributor & Agent Orientation

> Orientation for anyone working in the Eco codebase — human or AI coding agent.
> `CLAUDE.md` is a symlink to this file; both names resolve to the same content.

## What Eco is

Eco is a **local-first AI chat app**: the model runs in the user's browser, so chat
never touches a server. The web app is the product; a small API gateway handles auth
and sessions only. Live at `econetwork.ai`.

## Repo scope

This repository is the **v1.0 web app**: the Next.js web app plus a minimal API gateway
for auth and sessions. A separate desktop/network product lives in its own repository and
is not part of this tree — if you find lingering references to miners, distributed
inference, on-chain anything, or P2P networking, that's stale and should be cleaned up,
not extended.

- `apps/web/` — Next.js 16 app: landing, `/chat` (on-device AI), settings, auth, content pages.
- `apps/api/` — Hono API gateway: auth + sessions (Better Auth) only. Chat never routes through it.
- `packages/ui/` — shared component library used by the web app.
- `packages/config/` — shared tsconfig + ESLint flat config.

## Tech stack

The dependency manifests (`package.json` in the root, apps, and packages) are the
source of truth for the stack.

**Pinned versions worth knowing:**

- `@huggingface/transformers`: **4.2.0, pinned exact** — it carries a local `pnpm` patch, so a version bump needs a deliberate, careful PR. Don't float it.
- `motion`: this is **not** `framer-motion`. The package was renamed; import from `motion/react`.
- `next`: bounded to the 16 major (`>=16.2.6 <17`).
- `tailwindcss`: 4.x — note the v4 CSS-first `@theme` conventions differ from v3.

## On-device AI

The shipping model catalog is the source of truth at
`apps/web/src/local-ai/catalog/catalog-data.json`. The on-device module
(`apps/web/src/local-ai/`) covers catalog, device profiling, download, recommendation,
runtime, and lifecycle.

A diagnostics surface for inspecting device capability, model selection, and download
behavior lives at `/diagnostics/local-ai?eco-diagnostics=1`.

## Design tokens and UI conventions

The UI is token-driven. Colors, typography, spacing, radius, and shadows come from
CSS custom properties (`--eco-*`); components should reference tokens rather than
hardcode values.

- Token sources of truth: `apps/web/app/globals.css` and
  `packages/ui/src/tokens/tokens.css`.
- Fonts are set via `--eco-font-*` (display: Fraunces; body/UI: DM Sans; mono:
  JetBrains Mono) — don't introduce other font stacks.
- Animation uses Motion v12 spring physics; respect `prefers-reduced-motion`.
- Reuse components from `packages/ui/` and `apps/web/src/components/` before adding
  new ones. Shared illustrations live in `packages/ui/src/illustrations/`.
- UI PR expectations (screenshots, states to cover) are in `CONTRIBUTING.md`.

## Quality rules

- TypeScript strict mode everywhere. No `any` — use `unknown` and narrow.
- Named exports preferred (except Next.js pages/layouts, which default-export).
- Prefer `type` over `interface` for object shapes; `interface` for extension.
- Always handle promise rejections.
- **AGPL-3.0 SPDX header on every new source file** (see `CONTRIBUTING.md` for the block).
- Minimal, readable solutions. No unnecessary abstractions. Atomic commits.
- Inspect existing code paths and patterns before editing.
- Run QA before claiming done — never assume tests pass.

## Running the project

```bash
pnpm qa              # everything CI gates on, in one command — run before a PR
```

The rest of the day-to-day commands are the standard ones in the root
`package.json` scripts (E2E runs via `pnpm --filter @eco/web exec playwright test`).

`pnpm qa` runs type-check, lint, the circular-dependency check, the unit suites, and
the full build, failing on the first problem. It mirrors the jobs that gate a merge,
so a green `pnpm qa` locally is the best signal that CI will be green too.

The on-device chat needs only the web app — see `README.md` for the zero-service
quickstart. **Ports:** web 3000, api 3001. Postgres `127.0.0.1:5432`, Redis
`127.0.0.1:6379`.

## Project policies (non-negotiable)

- **Text and code only.** Never add image/audio/video *generation* features.
- **No telemetry by default.** Anything that phones home is opt-in with a clear explanation.
- **AGPL-3.0** SPDX header on every source file.
- **Privacy claims must be accurate.** Never overclaim what "local-first" or "on-device"
  means: inference runs on-device, but conversations can persist locally (OPFS /
  IndexedDB) and auth is genuinely server-side. Be explicit about what stays where.
- **Eco is free. There are no tiers, plans or feature gates.** Donations, if offered, are
  optional, external, and buy nothing.

## For AI coding agents

This file is the shared, checked-in orientation every agent and contributor works from.
Keep private, machine-specific, or session-local context (scratch notes, your own
tooling config, environment quirks) in a local-only `CLAUDE.local.md` (already in
`.gitignore`) rather than editing this file.
