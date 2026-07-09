// @ts-check
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC
import baseConfig from "./base.mjs";
import nextPlugin from "@next/eslint-plugin-next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactPlugin from "eslint-plugin-react";
import tseslint from "typescript-eslint";

// jsx-a11y's recommended preset ships most rules as errors (a few are "off").
// Per the staged lint policy (review-2026-05-27 D3.1), new accessibility
// findings land as warnings first so CI stays green, then get ratcheted to
// errors over time. Only promote rules whose recommended severity is NOT "off"
// — re-enabling deliberately-disabled rules would add false positives.
const a11yRulesAsWarnings = Object.fromEntries(
  Object.entries(jsxA11y.flatConfigs.recommended.rules ?? {})
    .filter(([, v]) => (Array.isArray(v) ? v[0] : v) !== "off")
    .map(([rule]) => [rule, "warn"])
);

export default tseslint.config(...baseConfig, {
  plugins: {
    "@next/next": nextPlugin,
    "jsx-a11y": jsxA11y,
    react: reactPlugin,
  },
  rules: {
    ...nextPlugin.configs.recommended.rules,
    ...nextPlugin.configs["core-web-vitals"].rules,
    // jsx-a11y recommended set, every rule staged as a warning (see above).
    ...a11yRulesAsWarnings,
    // Every <button> must declare an explicit type — implicit "submit"
    // inside forms is a common, hard-to-spot footgun.
    "react/button-has-type": "error",
  },
  languageOptions: {
    parserOptions: {
      project: true,
      ecmaFeatures: {
        jsx: true,
      },
    },
  },
});
