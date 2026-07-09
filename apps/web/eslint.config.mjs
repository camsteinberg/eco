// @ts-check
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC
import nextjs from "@eco/config/eslint/nextjs";
import { stageStrictTypedAsWarnings } from "@eco/config/eslint/stage-strict-typed";
import pluginSecurity from "eslint-plugin-security";
import tseslint from "typescript-eslint";

// To ratchet a rule back to error, add it to RATCHETED here (NOT in
// base.mjs — the staging helper re-downgrades base-level errors).
const RATCHETED = new Set([
  // Add rules here to promote back to error, e.g.:
  // "@typescript-eslint/no-floating-promises",
]);

const staged = stageStrictTypedAsWarnings(nextjs, { ratcheted: RATCHETED });

export default tseslint.config(
  // Shared Next.js base: typescript-eslint strict + stylistic, Next.js
  // recommended + core-web-vitals, jsx-a11y (staged as warnings), and
  // react/button-has-type. See packages/config/eslint/nextjs.mjs.
  ...nextjs,
  // App-specific security linting. The shared base does not ship the security
  // plugin; keep its noisier heuristics disabled to avoid false positives.
  pluginSecurity.configs.recommended,
  {
    rules: {
      // Stage the strict-typed backlog as warnings (ratchet to error later).
      ...staged,
      "@typescript-eslint/no-explicit-any": "warn",
      "security/detect-object-injection": "off",
      "security/detect-non-literal-regexp": "off",
      "security/detect-possible-timing-attacks": "off",
      "security/detect-unsafe-regex": "off",
      "security/detect-non-literal-fs-filename": "off",
    },
  },
  {
    // Plain JS/MJS files (service worker, ops scripts) live outside the
    // TypeScript project, so type-aware rules cannot run on them.
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["**/*.test.{ts,tsx}", "**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["public/sw.js"],
    languageOptions: {
      globals: {
        URL: "readonly",
        self: "readonly",
        fetch: "readonly",
        caches: "readonly",
        Response: "readonly",
      },
    },
  },
  {
    // Build verification + ops scripts run under plain Node, not the
    // Next.js bundler — they need Node globals.
    files: ["scripts/**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".next/**",
      "public/runtimes/**",
      // Build-copied engine statics (scripts/copy-runtime-assets.mjs) —
      // gitignored, so CI never sees them; without this ignore any dev who
      // has built locally gets a red lint gate on vendored Emscripten JS.
      "public/litert-wasm/**",
      "public/ort/**",
      "*.config.*",
      "next-env.d.ts",
    ],
  }
);
