# Web Frontend Guide

This subtree is frontend work. Always follow the UI guidelines in `CONTRIBUTING.md` in addition to the repo root `AGENTS.md`.

## Scope

This file applies to work in `apps/web/`.

## Required Workflow

1. Read the UI guidelines in `CONTRIBUTING.md` before substantial UI work.
2. Reuse existing components from `apps/web/src/components/` and `packages/ui/` before creating new patterns.
3. Use the design tokens (`packages/ui/src/tokens/tokens.css`, `apps/web/app/globals.css`); avoid hardcoded colors, fonts, spacing, or shadows.
4. Review changed UI against the frontend checklist before finishing.
5. After visual or interaction changes, run Playwright validation and capture screenshots when quality or regressions matter.

## Verification Defaults

- Prefer package-scoped checks first: `pnpm --filter @eco/web test`
- Run `pnpm --filter @eco/web lint` or broader linting when relevant
- Run `pnpm --filter @eco/web exec playwright test` for UI behavior or visual changes when feasible

## Notes

- URL-reflecting state matters in this app. Filters, tabs, pagination, and comparable state should be deep-linkable when it improves usability.
- Accessibility, motion restraint, and screenshot-worthiness are part of done, not polish.
