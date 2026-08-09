// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { expect, test, type Page } from "@playwright/test";

/**
 * The production bundle must load clean.
 *
 * This is the gate's browser check. It loads the app's two load-bearing
 * surfaces against a real `next start` build and fails on any uncaught page
 * error or `console.error`. It exists because a build miscompilation once
 * shipped a chunk that threw at module evaluation while the entire unit suite
 * and a forced `pnpm qa` passed green.
 *
 * Deliberately shallow: it asserts the page loads and its console is clean,
 * nothing about behaviour. Behavioural coverage lives in `e2e/`.
 */

const SEEDED_SLOT_MODEL_ID = "candidate/qwen3.5-2b-onnx";

/**
 * Console noise that is NOT a bundle defect and would make the lane flaky.
 *
 * Keep this list short and justified — every entry is a hole in the gate.
 * Anything added here must be noise the browser or a mocked-away service
 * produces, never anything our own modules emit.
 */
const IGNORED_CONSOLE_PATTERNS: ReadonlyArray<RegExp> = [
  // Chromium logs a console error for every request the test itself aborts
  // (the model CDN, blocked below so the smoke never downloads 1.5 GB).
  /net::ERR_FAILED/,
  /net::ERR_BLOCKED_BY_CLIENT/,
  /Failed to load resource/,
  // No API gateway runs in this lane; auth/session calls are mocked, but the
  // service worker and Sentry probes can still surface transport noise.
  /Sentry/i,
  // The local-AI setup pipeline correctly reports that it cannot fetch a model
  // here: the lane blocks the model CDN on purpose and Playwright's ephemeral
  // profile reports ~1 GB of quota. This diagnostic is the app working, and it
  // is environment-dependent, so it must not gate the build. It is a narrow
  // literal tag, not a wildcard — bundle defects never carry it.
  /\[eco-setup-failure\]/,
];

function isIgnorable(text: string): boolean {
  return IGNORED_CONSOLE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Mock the API gateway and block the model CDN so the lane is hermetic. */
async function isolatePage(page: Page): Promise<void> {
  await page.route("**/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/internal/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/auth/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: pathname.endsWith("/api/auth/get-session")
        ? JSON.stringify({
            session: {
              id: "smoke-session",
              userId: "smoke-user",
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            user: {
              id: "smoke-user",
              email: "smoke@example.com",
              name: "Smoke",
              emailVerified: true,
            },
          })
        : "{}",
    });
  });

  // Never pull model weights in the gate.
  await page.route(/huggingface\.co|r2\.dev|econetwork\.ai|cdn\./, (route) =>
    route.abort(),
  );

  // Seed a ready model slot so the chat surface mounts its real UI instead of
  // parking on the bootstrap/setup gate.
  await page.addInitScript((modelId) => {
    try {
      window.localStorage.setItem("eco-local-ai-slot-eco-fast", modelId);
      window.localStorage.setItem("eco-local-ai-slot-status-eco-fast", "ready");
    } catch {
      // localStorage may be unavailable; the seed is best-effort.
    }
  }, SEEDED_SLOT_MODEL_ID);
}

type Surface = { readonly path: string; readonly label: string };

const SURFACES: ReadonlyArray<Surface> = [
  { path: "/chat", label: "chat" },
  {
    path: "/diagnostics/local-ai?eco-diagnostics=1",
    label: "local-ai diagnostics",
  },
];

for (const surface of SURFACES) {
  test(`production bundle loads clean: ${surface.label}`, async ({ page }) => {
    const problems: string[] = [];

    page.on("pageerror", (error) => {
      problems.push(`uncaught: ${error.message}`);
    });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (isIgnorable(text)) return;
      problems.push(`console.error: ${text}`);
    });

    await isolatePage(page);

    const response = await page.goto(surface.path, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status(), `${surface.path} should serve 200`).toBe(200);

    // Give client modules time to evaluate and hydrate. A module-evaluation
    // throw surfaces as a `pageerror` during this window.
    await page.waitForLoadState("networkidle").catch(() => {
      // networkidle can never settle if a poller is running; the timeout below
      // is the real bound.
    });
    await page.waitForTimeout(1_500);

    expect(
      problems,
      `${surface.path} logged browser errors against the production build:\n` +
        problems.join("\n"),
    ).toEqual([]);
  });
}
