// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import config from "../../playwright.config";

function getWebServers() {
  return Array.isArray(config.webServer)
    ? config.webServer
    : config.webServer
      ? [config.webServer]
      : [];
}

describe("playwright config", () => {
  it("uses the canonical local mission ports for the web and api stack", () => {
    const [apiServer, webServer] = getWebServers();

    expect(config.use?.baseURL).toBe("http://localhost:3000");
    expect(apiServer?.url).toBe("http://127.0.0.1:3001/health/ready");
    expect(apiServer?.command).toContain("PORT=3001");
    expect(apiServer?.command).toContain(
      "BETTER_AUTH_BASE_URL=http://127.0.0.1:3001",
    );
    expect(apiServer?.command).toContain(
      "WEB_URL=http://localhost:3000",
    );
    expect(apiServer?.command).toContain("pnpm --filter @eco/api dev");
    expect(webServer?.url).toBe("http://localhost:3000");
    expect(webServer?.command).toContain("PORT=3000");
    expect(webServer?.command).toContain(
      "NEXT_PUBLIC_API_URL=http://127.0.0.1:3001",
    );
    expect(webServer?.command).toContain("pnpm --filter @eco/web dev");
  });

  it("enables the validation harness so no-egress local fixtures can run without real artifacts", () => {
    const [, webServer] = getWebServers();

    expect(webServer?.command).toContain("NEXT_PUBLIC_ECO_VALIDATION_HARNESS=true");
  });
});
