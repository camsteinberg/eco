<!--
Thanks for contributing to Eco! Please fill this out so reviewers have the context
they need. Keep PRs small and focused — one change per PR is much easier to merge.
-->

## What & why

<!-- What does this change do, and why? Link any related issue (e.g. "Closes #123"). -->

## How it was tested

<!-- What did you run and observe? -->

- [ ] `pnpm type-check`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm check:cycles`
- [ ] `pnpm --filter @eco/web exec playwright test` (if this touches user-facing flows)

## UI changes

<!-- Delete this section if your change isn't visual. -->

- [ ] Uses design tokens — no hardcoded colors, fonts, spacing, radius, or shadows
- [ ] Reuses `packages/ui/` / existing components before adding new ones
- [ ] Screenshots attached below (light and dark; mobile if responsive)

## Checklist

- [ ] Commits are signed off under the DCO (`git commit -s`)
- [ ] New source files carry the `AGPL-3.0-or-later` SPDX header
- [ ] Behavior changes come with tests
