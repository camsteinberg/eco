// @ts-check
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC
import baseConfig from "./base.mjs";
import tseslint from "typescript-eslint";

export default tseslint.config(...baseConfig, {
  languageOptions: {
    parserOptions: {
      project: true,
    },
  },
});
