# Shared UI Guide

This subtree is frontend work. Always follow the UI guidelines in `CONTRIBUTING.md` in addition to the repo root `AGENTS.md`.

## Scope

This file applies to work in `packages/ui/`.

## Required Workflow

1. Read the UI guidelines in `CONTRIBUTING.md` before substantial component or styling work.
2. Build primitives that are accessible, resilient, and reusable across web and desktop surfaces.
3. Keep primitives token-driven and accessible without baking app-specific assumptions into shared primitives.
4. Review component API, states, keyboard behavior, and visual fit before finishing.
5. Verify changes in at least one consuming surface when practical if appearance or interaction changed.

## Verification Defaults

- Prefer package-scoped checks first: `pnpm --filter @eco/ui test`
- Run relevant lint or type checks if the change affects consumers
- Use Playwright or another visual validation path when the change is user-visible

## Notes

- Shared UI should favor semantic HTML, predictable APIs, and accessible defaults.
- Keep primitives consistent with the existing token system and component patterns.
