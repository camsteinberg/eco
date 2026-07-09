// @ts-check
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC
import node from "@eco/config/eslint/node";
import { stageStrictTypedAsWarnings } from "@eco/config/eslint/stage-strict-typed";
import pluginSecurity from "eslint-plugin-security";
import tseslint from "typescript-eslint";

// To ratchet a rule back to error, add it to RATCHETED here (NOT in
// base.mjs — the staging helper re-downgrades base-level errors).
const RATCHETED = new Set([
  // Add rules here to promote back to error, e.g.:
  // "@typescript-eslint/no-floating-promises",
]);

const staged = stageStrictTypedAsWarnings(node, { ratcheted: RATCHETED });

export default tseslint.config(
  // Shared Node base: typescript-eslint strict + stylistic, type-aware.
  // See packages/config/eslint/node.mjs.
  ...node,
  // App-specific security linting. The shared base does not ship the security
  // plugin.
  pluginSecurity.configs.recommended,
  {
    rules: {
      // Stage the strict-typed backlog as warnings (ratchet to error later).
      ...staged,
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Test files (*.test.ts) are excluded from tsconfig (see tsconfig.json),
    // so type-aware rules cannot run on them — disable typed linting there.
    // Glob matches tsconfig's exclude exactly: only *.test.{ts,tsx} files.
    // Non-test helpers under __tests__/helpers/ stay type-aware.
    files: ["**/*.test.{ts,tsx}"],
    ...tseslint.configs.disableTypeChecked,
  }
);
