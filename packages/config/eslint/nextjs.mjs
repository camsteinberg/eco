// @ts-check
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC
import baseConfig from "./base.mjs";
import nextPlugin from "@next/eslint-plugin-next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactPlugin from "eslint-plugin-react";
import tseslint from "typescript-eslint";

// jsx-a11y's recommended preset ships most rules as errors (a few are "off").
// The staged lint policy (review-2026-05-27 D3.1) landed them as warnings first
// so CI stayed green while the backlog was worked down. That ratchet is now
// complete: they are errors, so a new accessibility violation fails the build
// instead of joining a warning pile nobody reads. Only rules whose recommended
// severity is NOT "off" are promoted — re-enabling deliberately-disabled rules
// would add false positives.
const a11yRulesAsErrors = Object.fromEntries(
  Object.entries(jsxA11y.flatConfigs.recommended.rules ?? {})
    .filter(([, v]) => (Array.isArray(v) ? v[0] : v) !== "off")
    .map(([rule]) => [rule, "error"])
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
    // jsx-a11y recommended set, every rule an error (see above).
    ...a11yRulesAsErrors,
    // `role` is a legitimate domain prop on our own components — a chat message
    // is rendered as <MessageBubble role="assistant">, which is the message
    // author, not an ARIA role. Without this the rule flags every such call
    // site. `ignoreNonDOM` keeps it enforcing on real DOM elements, where the
    // check actually means something, and skips custom components.
    "jsx-a11y/aria-role": ["error", { ignoreNonDOM: true }],
    // A `tabpanel` and a scrollable `log` are both containers the ARIA
    // Authoring Practices say SHOULD be focusable — the tabpanel so the tab
    // sequence continues into the panel, the log so a keyboard user can scroll
    // the transcript at all (WCAG 2.1.1). The rule has no way to know that, so
    // the two roles are allowlisted rather than the rule turned off.
    "jsx-a11y/no-noninteractive-tabindex": [
      "error",
      { tags: [], roles: ["tabpanel", "log"], allowExpressionValues: true },
    ],
    // A <label> wrapping a control and a two-level <span> block for the title
    // and its sub-line still names the control correctly — the accessible name
    // is the label's whole text content. The default depth of 2 stops one level
    // short of that markup; `assert` stays at its default, so a label with no
    // associated control is still an error.
    "jsx-a11y/label-has-associated-control": ["error", { depth: 3 }],
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
