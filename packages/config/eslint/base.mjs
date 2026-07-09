// @ts-check
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    rules: {
      // Prefer `type` keyword for type-only imports
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // No floating promises
      "@typescript-eslint/no-floating-promises": "error",
      // No unused vars — use _ prefix to suppress
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Allow void operator to discard floating promises explicitly
      "no-void": ["error", { allowAsStatement: true }],
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", ".next/**", "*.config.*"],
  }
);
