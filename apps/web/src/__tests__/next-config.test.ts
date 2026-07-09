// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("web Next config", () => {
  it("pins Turbopack to the repo workspace root", () => {
    const expectedRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../.."
    );

    expect(nextConfig.turbopack?.root).toBe(expectedRoot);
  });
});
