// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { expect, type Page } from "@playwright/test";
import type { CaptureGap, StateEntry } from "../types";
import { READY_CHAT_SEARCH } from "./pilot";

/**
 * W1 — routes and pages.
 *
 * Everything a person can reach by typing a URL: the settings tabs (member and
 * guest), the four auth pages and the states their forms can be in, the trust
 * pages, the early-access gate, 404, and the diagnostics surface. Chat itself is
 * W3's; this wave stops at the app shell's other doors.
 *
 * Two states that belong to this inventory are deliberately NOT re-declared
 * here, because the pilot group already shoots them at the same route, tier and
 * capture mode — a second id would be byte-identical pixels, which the coverage
 * check (rightly) fails as a duplicate:
 *
 * - `/privacy` → `pilot.privacy-page`
 * - `/settings?tab=account` signed in → `pilot.settings-account`
 *
 * If the pilot group is ever retired, those two move here.
 *
 * ── Three states this wave deliberately does NOT capture ──────────────────
 *
 * 1. The route-level loading skeletons (`chat/loading.tsx`,
 *    `settings/loading.tsx`). Probed on 2026-08-18 against the running dev
 *    server, two ways, and NEITHER reaches the skeleton:
 *      - client-side navigation with the destination's RSC payload held open →
 *        Next 16 keeps the CURRENT page on screen and never commits, so the
 *        page stayed on /settings with zero `.skeleton-shimmer` nodes;
 *      - full-document navigation with the document held → the browser simply
 *        stays on the old page; there is nothing to render.
 *    Both routes are client components with no server-side suspense, so the
 *    fallback has no honest trigger from the outside. Capturing one would mean
 *    rendering the component directly, which is a screenshot of a React tree,
 *    not of the product. Left uncaptured on purpose.
 *
 * 2. `error.tsx` / `global-error.tsx`. There is no in-app way to make a route
 *    throw, and adding a magic "throw on this param" to `src/` is app surgery
 *    for a screenshot's benefit. The `server: 'prod'` mechanism these would
 *    need already exists (the dev error overlay is exactly what the runner
 *    refuses to photograph), so an entry is cheap once a legitimate trigger
 *    does.
 *
 * 3. The `/gate` Suspense fallback ("Loading gate…"). Same problem as (1) and
 *    a far smaller prize — it is one line of centred text.
 */

/** A signed-in settings tab. The tab param is what selects the panel. */
function settingsTab(
  name: string,
  tab: string,
  title: string,
  assertText: string,
): StateEntry {
  return {
    id: `routes.settings-${name}`,
    group: "routes",
    title,
    route: "/settings",
    search: `tab=${tab}`,
    auth: "signed-in",
    tier: "page",
    // The session is a fulfilled route mock, so nothing on these screens is a
    // real account.
    realism: "mocked",
    assert: [{ text: assertText }],
  };
}

/** Type into a labelled field on one of the auth cards. */
async function fill(page: Page, selector: string, value: string): Promise<void> {
  await page.locator(selector).first().fill(value);
}

/** Submit an auth form by its primary button and wait for the form to react. */
async function submit(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).first().click();
}

/**
 * The alert carrying a particular message.
 *
 * `getByRole('alert')` alone is ambiguous on every route: Next.js ships an empty
 * `#__next-route-announcer__` with the same role, so a bare lookup trips strict
 * mode instead of failing on the thing being tested.
 */
function alert(page: Page, text: string) {
  return page.getByRole("alert").filter({ hasText: text }).first();
}

/**
 * Fake one better-auth endpoint.
 *
 * The base fixtures already fulfil every `/api/auth/**` call with `200 {}`,
 * which reads as success — so an error state has to register its own, narrower
 * route afterwards (Playwright matches in reverse registration order). The body
 * shape is what better-auth's client turns into `error.code`.
 */
function authFailure(pathSuffix: string, status: number, code: string) {
  return async (page: Page): Promise<void> => {
    await page.route(`**/api/auth/${pathSuffix}`, (route) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ code, message: code }),
      }),
    );
  };
}

/** The `/api/gate` probe the gate page runs on mount. */
function gateStatus(configured: boolean) {
  return async (page: Page): Promise<void> => {
    await page.route("**/api/gate", async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ configured }),
        });
      }
      // A wrong password: the page only distinguishes ok from not-ok.
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "invalid" }),
      });
    });
  };
}

/** The three surfaces this file's header explains at length, in a printable form. */
export const routesGaps: CaptureGap[] = [
  {
    id: "routes.loading-skeleton",
    group: "routes",
    surface: "Route-level loading skeletons (chat/loading.tsx, settings/loading.tsx)",
    reason:
      "Probed 2026-08-18 two ways and neither reaches the fallback: a client-side navigation with the destination's "
      + "RSC payload held open leaves Next 16 on the CURRENT page (zero .skeleton-shimmer nodes), and a held document "
      + "navigation simply stays put. Both routes are client components with no server-side suspense, so the fallback "
      + "has no honest trigger from outside; rendering the component directly would photograph a React tree, not the product.",
  },
  {
    id: "routes.error-boundary",
    group: "routes",
    surface: "error.tsx and global-error.tsx",
    reason:
      "There is no in-app way to make a route throw, and adding a throw-on-this-param seam to src/ is app surgery for a "
      + "screenshot's benefit. The server:'prod' mechanism these need already exists, so an entry is cheap the day a "
      + "legitimate trigger does.",
  },
  {
    id: "routes.gate-suspense-fallback",
    group: "routes",
    surface: "The /gate Suspense fallback (“Loading gate…”)",
    reason:
      "Same missing trigger as the loading skeletons, for a far smaller prize: one line of centred text.",
  },
];

export const routesStates: StateEntry[] = [
  // ── Settings, signed in ────────────────────────────────────────────────
  settingsTab("support", "support", "Settings — support tab (signed in)", "Get in touch"),
  settingsTab("billing", "billing", "Settings — billing tab (signed in)", "Your plan"),
  settingsTab("appearance", "appearance", "Settings — appearance tab (signed in)", "Theme"),
  {
    ...settingsTab("models", "models", "Settings — models tab (signed in)", "Currently running"),
    // Without a forced device and a ready slot, "Currently running" reports
    // whatever the host machine happens to profile as.
    search: `tab=models&${READY_CHAT_SEARCH}`,
    notes: "Device and slot are harness-forced so the running-model line is the same on every machine.",
  },

  // ── Settings, guest ────────────────────────────────────────────────────
  // A guest sees the same three open tabs plus a padlock on the two that need
  // an account, so these are not pixel twins of the signed-in shots.
  {
    id: "routes.settings-guest-appearance",
    group: "routes",
    title: "Settings — appearance tab (guest)",
    route: "/settings",
    search: "tab=appearance",
    tier: "page",
    realism: "real",
    assert: [{ text: "Theme" }],
    notes: "Appearance is the guest default tab, and the one a signed-out visitor most often lands on.",
  },
  {
    id: "routes.settings-guest-support",
    group: "routes",
    title: "Settings — support tab (guest)",
    route: "/settings",
    search: "tab=support",
    tier: "page",
    realism: "real",
    assert: [{ text: "Get in touch" }],
  },
  {
    id: "routes.settings-guest-models",
    group: "routes",
    title: "Settings — models tab (guest)",
    route: "/settings",
    search: `tab=models&${READY_CHAT_SEARCH}`,
    tier: "page",
    realism: "seeded",
    assert: [{ text: "Currently running" }],
  },
  {
    id: "routes.settings-guest-account-locked",
    group: "routes",
    title: "Settings — account tab locked for a guest",
    route: "/settings",
    search: "tab=account",
    tier: "component",
    realism: "real",
    assert: [
      { text: "Your account" },
      { text: "Sign in to manage your profile, data exports, and account deletion." },
    ],
    notes: "LockedSettingsPreview — the promise a guest is shown instead of an empty account screen.",
  },
  {
    id: "routes.settings-guest-billing-locked",
    group: "routes",
    title: "Settings — billing tab locked for a guest",
    route: "/settings",
    search: "tab=billing",
    tier: "component",
    realism: "real",
    assert: [
      { text: "Plan & billing" },
      { text: "Local AI stays free for everyone." },
    ],
  },

  // ── Settings, billing return banners ───────────────────────────────────
  {
    id: "routes.settings-billing-success",
    group: "routes",
    title: "Settings — billing, returned from a completed checkout",
    route: "/settings",
    search: "tab=billing&billing=success",
    auth: "signed-in",
    tier: "component",
    realism: "mocked",
    assert: [{ text: "Supporter membership is active" }],
    notes: "Stripe sends the customer back to ?billing=success; this is the banner they land on.",
  },
  {
    id: "routes.settings-billing-canceled",
    group: "routes",
    title: "Settings — billing, returned from a canceled checkout",
    route: "/settings",
    search: "tab=billing&billing=canceled",
    auth: "signed-in",
    tier: "component",
    realism: "mocked",
    assert: [{ text: "Checkout was canceled" }],
  },

  // ── Sign in ────────────────────────────────────────────────────────────
  {
    id: "routes.sign-in",
    group: "routes",
    title: "Sign in",
    route: "/sign-in",
    tier: "page",
    realism: "real",
    assert: [{ role: "heading", name: "Welcome back" }],
  },
  {
    id: "routes.sign-in-required-fields",
    group: "routes",
    title: "Sign in — submitted empty",
    route: "/sign-in",
    tier: "component",
    realism: "real",
    assert: [{ role: "heading", name: "Welcome back" }],
    prepare: async (page) => {
      await submit(page, "Sign in");
      await expect(page.getByText("Email is required")).toBeVisible();
      await expect(page.getByText("Password is required")).toBeVisible();
    },
    notes: "Client-side validation only — nothing is sent, both fields report at once.",
  },
  {
    id: "routes.sign-in-invalid-email",
    group: "routes",
    title: "Sign in — email that is not an address",
    route: "/sign-in",
    tier: "component",
    realism: "real",
    assert: [{ role: "heading", name: "Welcome back" }],
    prepare: async (page) => {
      await fill(page, "#email", "not-an-address");
      await fill(page, "#password", "hunter2hunter2");
      await submit(page, "Sign in");
      await expect(page.getByText("Enter a valid email address")).toBeVisible();
    },
  },
  {
    id: "routes.sign-in-invalid-credentials",
    group: "routes",
    title: "Sign in — email or password does not match",
    route: "/sign-in",
    tier: "component",
    realism: "mocked",
    assert: [{ role: "heading", name: "Welcome back" }],
    mock: authFailure("sign-in/email", 401, "INVALID_EMAIL_OR_PASSWORD"),
    prepare: async (page) => {
      await fill(page, "#email", "person@example.com");
      await fill(page, "#password", "the-wrong-password");
      await submit(page, "Sign in");
      // The dedicated alert, not the bland generic one — the inline reset link
      // is the whole point of this state.
      await expect(alert(page, "That email or password doesn")).toBeVisible();
      await expect(page.getByRole("link", { name: "reset your password" })).toBeVisible();
    },
    notes: "Mapped from better-auth's INVALID_EMAIL_OR_PASSWORD code, faked here as a 401.",
  },
  {
    id: "routes.sign-in-signed-out-notice",
    group: "routes",
    title: "Sign in — after signing out",
    route: "/sign-in",
    search: "signedOut=1",
    tier: "component",
    realism: "real",
    assert: [{ text: "Continue privately as a guest, or sign back in to manage your account." }],
    notes: "Where sign-out lands. The notice has to read as a confirmation, not an error.",
  },
  {
    id: "routes.sign-in-password-shown",
    group: "routes",
    title: "Sign in — password revealed",
    route: "/sign-in",
    tier: "component",
    realism: "real",
    assert: [{ role: "heading", name: "Welcome back" }],
    prepare: async (page) => {
      await fill(page, "#password", "a-visible-password");
      await page.getByRole("button", { name: "Show password" }).click();
      // The toggle's proof is the input's type, not the icon.
      await expect(page.locator("#password")).toHaveAttribute("type", "text");
    },
  },

  // ── Sign up ────────────────────────────────────────────────────────────
  {
    id: "routes.sign-up",
    group: "routes",
    title: "Create an account",
    route: "/sign-up",
    tier: "page",
    realism: "real",
    assert: [{ role: "heading", name: "Create your account" }],
  },
  {
    id: "routes.sign-up-duplicate-email",
    group: "routes",
    title: "Create an account — email already registered",
    route: "/sign-up",
    tier: "component",
    realism: "mocked",
    assert: [{ role: "heading", name: "Create your account" }],
    mock: authFailure("sign-up/email", 422, "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"),
    prepare: async (page) => {
      await fill(page, "#name", "Sam Rivera");
      await fill(page, "#email", "person@example.com");
      await fill(page, "#password", "a-long-enough-password");
      await submit(page, "Create account");
      await expect(alert(page, "An account with this email already exists.")).toBeVisible();
    },
    notes: "Enumeration hygiene is relaxed here on purpose (ruling R-D7) — the offer is to sign in instead.",
  },
  {
    id: "routes.sign-up-password-too-short",
    group: "routes",
    title: "Create an account — password under eight characters",
    route: "/sign-up",
    tier: "component",
    realism: "real",
    assert: [{ role: "heading", name: "Create your account" }],
    prepare: async (page) => {
      await fill(page, "#name", "Sam Rivera");
      await fill(page, "#email", "person@example.com");
      await fill(page, "#password", "short");
      await submit(page, "Create account");
      await expect(page.getByText("Password must be at least 8 characters")).toBeVisible();
    },
  },

  // ── Forgot password ────────────────────────────────────────────────────
  {
    id: "routes.forgot-password",
    group: "routes",
    title: "Forgot password — request a link",
    route: "/forgot-password",
    tier: "page",
    realism: "real",
    assert: [{ role: "heading", name: "Reset your password" }],
  },
  {
    id: "routes.forgot-password-sent",
    group: "routes",
    title: "Forgot password — link on its way",
    route: "/forgot-password",
    tier: "component",
    realism: "mocked",
    assert: [{ role: "heading", name: "Reset your password" }],
    mock: async (page) => {
      await page.route("**/api/auth/request-password-reset", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
      );
    },
    prepare: async (page) => {
      await fill(page, "#email", "person@example.com");
      await submit(page, "Send reset link");
      await expect(page.getByText("Check your email for a reset link.")).toBeVisible();
    },
    notes: "The success screen is deliberately identical whether or not the address exists.",
  },

  // ── Reset password ─────────────────────────────────────────────────────
  {
    id: "routes.reset-password-incomplete-link",
    group: "routes",
    title: "Reset password — link arrived without a token",
    route: "/reset-password",
    tier: "page",
    realism: "real",
    assert: [
      { role: "heading", name: "This reset link isn't valid" },
      { text: "This link is incomplete." },
    ],
    notes: "A tokenless link can never succeed, so the form is never rendered for it.",
  },
  {
    id: "routes.reset-password-expired-link",
    group: "routes",
    title: "Reset password — link expired",
    route: "/reset-password",
    search: "error=INVALID_TOKEN",
    tier: "component",
    realism: "real",
    assert: [
      { role: "heading", name: "This reset link isn't valid" },
      { text: "Reset links only last an hour." },
    ],
    notes: "Better Auth bounces a dead link here with ?error=INVALID_TOKEN and no token.",
  },
  {
    id: "routes.reset-password-form",
    group: "routes",
    title: "Reset password — set a new one",
    route: "/reset-password",
    search: "token=capture-reset-token",
    tier: "page",
    realism: "real",
    assert: [{ role: "heading", name: "Set new password" }],
  },
  {
    id: "routes.reset-password-mismatch",
    group: "routes",
    title: "Reset password — the two fields disagree",
    route: "/reset-password",
    search: "token=capture-reset-token",
    tier: "component",
    realism: "real",
    assert: [{ role: "heading", name: "Set new password" }],
    prepare: async (page) => {
      await fill(page, "#password", "a-long-enough-password");
      await fill(page, "#confirm-password", "a-different-password");
      await submit(page, "Reset password");
      await expect(page.getByText("Passwords do not match")).toBeVisible();
    },
  },
  {
    id: "routes.reset-password-done",
    group: "routes",
    title: "Reset password — done",
    route: "/reset-password",
    search: "token=capture-reset-token",
    tier: "component",
    realism: "mocked",
    // The card heading survives into the success state, so it is true before
    // and after the submit.
    assert: [{ role: "heading", name: "Set new password" }],
    mock: async (page) => {
      await page.route("**/api/auth/reset-password", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
      );
    },
    prepare: async (page) => {
      await fill(page, "#password", "a-long-enough-password");
      await fill(page, "#confirm-password", "a-long-enough-password");
      await submit(page, "Reset password");
      await expect(page.getByText("Your password has been reset successfully.")).toBeVisible();
    },
  },

  // ── Early-access gate ──────────────────────────────────────────────────
  {
    id: "routes.gate-open",
    group: "routes",
    title: "Early access — gate not configured",
    route: "/gate",
    tier: "page",
    realism: "real",
    assert: [{ text: "The private launch gate is open right now." }],
    notes:
      "What /gate renders with no SITE_PASSWORD set: it asks nothing and offers the way in. "
      + "The capture server deliberately runs with SITE_PASSWORD empty.",
  },
  {
    id: "routes.gate-password-form",
    group: "routes",
    title: "Early access — password required",
    route: "/gate",
    search: "returnTo=%2Fchat",
    tier: "page",
    realism: "mocked",
    mock: gateStatus(true),
    assert: [{ text: "Access password" }],
    notes: "The shipping production state, reached by faking the /api/gate probe as configured.",
  },
  {
    id: "routes.gate-wrong-password",
    group: "routes",
    title: "Early access — wrong password",
    route: "/gate",
    search: "returnTo=%2Fchat",
    tier: "component",
    realism: "mocked",
    mock: gateStatus(true),
    assert: [{ text: "Access password" }],
    prepare: async (page) => {
      await fill(page, "#gate-password", "not-the-password");
      await submit(page, "Enter");
      await expect(alert(page, "right. Try again.")).toBeVisible();
    },
  },

  // ── Not found ──────────────────────────────────────────────────────────
  {
    id: "routes.not-found",
    group: "routes",
    title: "404 — no such page",
    route: "/this-page-does-not-exist",
    tier: "page",
    realism: "real",
    assert: [{ text: "Looks like you wandered off the trail" }],
    notes: "Reached by navigating to a route that genuinely does not exist, not by rendering the component.",
  },

  // ── Trust pages ────────────────────────────────────────────────────────
  // `/privacy` lives in the pilot group (see the header note).
  {
    id: "routes.terms",
    group: "routes",
    title: "Terms of Service (full page)",
    route: "/terms",
    tier: "page",
    realism: "real",
    capture: { mode: "fullPage" },
    assert: [{ role: "heading", name: "Terms of Service" }],
  },
  {
    id: "routes.transparency",
    group: "routes",
    title: "Transparency (full page)",
    route: "/transparency",
    tier: "page",
    realism: "real",
    capture: { mode: "fullPage" },
    assert: [{ role: "heading", name: "Transparency" }],
  },
  {
    id: "routes.impact",
    group: "routes",
    title: "Our Impact (full page)",
    route: "/impact",
    tier: "page",
    realism: "real",
    capture: { mode: "fullPage" },
    assert: [{ role: "heading", name: "Our Impact" }],
    notes:
      "Every section starts at opacity 0 behind a scroll reveal. The screenshot's "
      + "animations:'disabled' fast-forwards the CSS fallback animation to its end frame, so the "
      + "full page comes out revealed rather than half-faded — verified by eye, not assumed.",
  },

  // ── Offline ────────────────────────────────────────────────────────────
  {
    id: "routes.offline-fallback",
    group: "routes",
    title: "Offline — the service worker's fallback document",
    route: "/chat",
    // The app registers its worker only in a production build, and only on a
    // loopback host when `eco-enable-local-sw` says so.
    server: "prod",
    serviceWorker: true,
    seed: {
      local: {
        "eco-enable-service-worker": "true",
        "eco-enable-local-sw": "true",
      },
      // The base bundle asks the app to skip registration; this state is the
      // one that needs it to happen. Removals run last, so this wins.
      removeSession: ["eco-skip-sw-registration-once"],
    },
    tier: "page",
    realism: "mocked",
    // Static HTML built inside sw.js — there is no React root to wait for.
    hydrates: false,
    mock: async (page) => {
      // Warm-up navigation: the worker registers on `load` and only serves
      // navigations once it controls the client.
      await page.goto("/chat");
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, {
        timeout: 30_000,
      });
      // Controlling the client is not the same as being done. Cutting the
      // network while the worker is still precaching — or while the warm-up
      // page still has requests in flight — aborts them, and the abort has
      // landed on the capture's own navigation instead
      // (`net::ERR_ABORTED at /chat`, once in the full-grid run on 2026-08-19).
      // Wait for an activated worker and a quiet page, then pull the plug.
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      await page.context().setOffline(true);
    },
    assert: [{ text: "Eco needs a connection to open" }],
    notes:
      "Not the app: a document the service worker itself synthesises when a navigation "
      + "cannot reach the network. It styles itself from prefers-color-scheme, so the "
      + "light and dark shots differ for a reason unrelated to the app's own theme.",
  },

  // ── Diagnostics ────────────────────────────────────────────────────────
  {
    id: "routes.diagnostics-locked",
    group: "routes",
    title: "Diagnostics — not enabled",
    route: "/diagnostics/local-ai",
    tier: "page",
    realism: "real",
    internal: true,
    assert: [{ role: "heading", name: "Diagnostics are not enabled" }],
  },
  {
    id: "routes.diagnostics-panel",
    group: "routes",
    title: "Diagnostics — local AI panel",
    route: "/diagnostics/local-ai",
    search: `eco-diagnostics=1&${READY_CHAT_SEARCH}`,
    tier: "page",
    realism: "seeded",
    internal: true,
    assert: [{ role: "heading", name: "Local AI Diagnostics" }],
    notes: "Device is harness-forced; otherwise the device-profile card reports the host machine.",
  },
];
