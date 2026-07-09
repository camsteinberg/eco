// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { test, expect, type Locator, type Page } from "@playwright/test";

/**
 * E2E tests auditing XSS attack vectors across the web application.
 *
 * These tests verify that common XSS injection techniques are neutralized
 * by CSP headers, React's built-in escaping, and react-markdown's default
 * URI sanitization.
 *
 * Prerequisites:
 *   - Web app running at http://localhost:3000 (or PLAYWRIGHT_BASE_URL)
 */

const SCRIPTABLE_PAYLOADS = [
  '<script>alert("xss")</script>',
  '"><img src=x onerror=alert(1)>',
  "javascript:alert(1)",
  '<svg onload=alert(1)>',
  "' onmouseover='alert(1)'",
];

const ASSISTANT_XSS_MARKDOWN = [
  'Raw HTML should stay inert: <img src=x onerror="alert(1)"><script>alert(1)</script>',
  "[dangerous link](javascript:alert(1))",
  "[unsafe data link](data:text/html,<script>alert(1)</script>)",
  '```"><img src=x onerror=alert(1)>',
  'console.log("safe code fence");',
  "```",
  "Citation marker [1] should not create scriptable links.",
].join("\n\n");

function registerDialogFailure(page: Page): string[] {
  const dialogs: string[] = [];

  page.on("dialog", (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });

  return dialogs;
}

async function expectNoDialogs(dialogs: string[]) {
  expect(dialogs, "XSS payload opened an alert/confirm/prompt dialog").toEqual([]);
}

async function getUnsafeDomFindings(scope: Page | Locator) {
  return scope.locator("*").evaluateAll((elements) => {
    const unsafeEventHandlers: string[] = [];
    const javascriptHrefs: string[] = [];
    const unsafeDataHrefs: string[] = [];

    for (const element of elements) {
      for (const attribute of Array.from(element.attributes)) {
        const attributeName = attribute.name.toLowerCase();
        const attributeValue = attribute.value.trim();

        if (attributeName.startsWith("on")) {
          unsafeEventHandlers.push(`${element.tagName.toLowerCase()}[${attribute.name}]`);
        }

        if (attributeName === "href" && /^javascript:/i.test(attributeValue)) {
          javascriptHrefs.push(attributeValue);
        }

        if (
          attributeName === "href"
          && /^data:/i.test(attributeValue)
          && !/^data:image\/(?:png|gif|jpe?g|webp);/i.test(attributeValue)
        ) {
          unsafeDataHrefs.push(attributeValue);
        }
      }
    }

    return {
      unsafeEventHandlers,
      javascriptHrefs,
      unsafeDataHrefs,
    };
  });
}

async function expectNoUnsafeDom(scope: Page | Locator) {
  const findings = await getUnsafeDomFindings(scope);

  expect(findings.unsafeEventHandlers, "No DOM event-handler attributes may be injected").toEqual([]);
  expect(findings.javascriptHrefs, "No javascript: hrefs may be rendered").toEqual([]);
  expect(findings.unsafeDataHrefs, "No unsafe data: hrefs may be rendered").toEqual([]);
}

async function expectNoInjectedScripts(page: Page) {
  const scriptFindings = await page.locator("script").evaluateAll((scripts) =>
    scripts
      .map((script) => script.textContent ?? "")
      .filter((scriptText) => /<(?:script|img|svg)\b|href\s*=\s*["']javascript:/i.test(scriptText))
      .map((scriptText) => scriptText.slice(0, 120))
  );

  expect(scriptFindings, "No injected script payload text may appear inside script tags").toEqual([]);
}

async function expectSafeRelativeHref(locator: Locator, expectedPath: string) {
  const href = (await locator.getAttribute("href")) ?? "";
  expect(href, `${expectedPath} link must stay on the expected relative route`).toMatch(
    new RegExp(`^${expectedPath.replace("/", "\\/")}(?:\\?|$)`)
  );

  const parsed = new URL(href, "http://127.0.0.1:3000");
  expect(parsed.origin).toBe("http://127.0.0.1:3000");
  expect(parsed.pathname).toBe(expectedPath);
}

test.describe("XSS attack vector audit", () => {
  test.describe("URL parameter injection", () => {
    for (const payload of SCRIPTABLE_PAYLOADS) {
      test(`query param injection is safe: ${payload.slice(0, 30)}...`, async ({
        page,
      }) => {
        const dialogs = registerDialogFailure(page);
        const encodedPayload = encodeURIComponent(payload);
        await page.goto(`/sign-in?callbackUrl=${encodedPayload}&prompt=${encodedPayload}`, {
          waitUntil: "domcontentloaded",
        });

        const continueAsGuest = page.getByRole("link", { name: /continue as guest/i });
        const signUp = page.getByRole("link", { name: /sign up/i });

        await expectSafeRelativeHref(continueAsGuest, "/chat");
        await expectSafeRelativeHref(signUp, "/sign-up");

        await expectNoInjectedScripts(page);
        await expectNoUnsafeDom(page);
        await expectNoDialogs(dialogs);
      });
    }
  });

  test.describe("Markdown link sanitization", () => {
    test("javascript: and unsafe data: protocol links are sanitized in rendered assistant markdown", async ({
      page,
    }) => {
      const dialogs = registerDialogFailure(page);
      const encodedPayload = encodeURIComponent(ASSISTANT_XSS_MARKDOWN);
      await page.goto(`/sign-in?prompt=${encodedPayload}`, {
        waitUntil: "domcontentloaded",
      });

      const continueAsGuest = page.getByRole("link", { name: /continue as guest/i });
      await expectSafeRelativeHref(continueAsGuest, "/chat");
      const renderedHrefs = await page.locator("a").evaluateAll((links) =>
        links.map((link) => link.getAttribute("href") ?? ""),
      );
      expect(renderedHrefs.filter((href) => /^javascript:/i.test(href))).toEqual([]);
      expect(renderedHrefs.filter((href) => /^data:/i.test(href))).toEqual([]);

      await expectNoUnsafeDom(page);
      await expectNoDialogs(dialogs);
    });
  });

  test.describe("Code block language XSS", () => {
    test("crafted language attribute does not inject HTML", async ({
      page,
    }) => {
      const dialogs = registerDialogFailure(page);
      const codeFencePayload = '```"><img src=x onerror=alert(1)>\nconsole.log("safe code fence");\n```';
      await page.goto(`/sign-in?prompt=${encodeURIComponent(codeFencePayload)}`, {
        waitUntil: "domcontentloaded",
      });

      await expect(page.locator("img[onerror]")).toHaveCount(0);
      await expectNoInjectedScripts(page);
      await expectNoUnsafeDom(page);
      await expectNoDialogs(dialogs);
    });
  });

  test.describe("Rendered assistant content", () => {
    test("raw assistant HTML is rendered as inert text, not DOM", async ({ page }) => {
      const dialogs = registerDialogFailure(page);
      const rawHtmlPayload = '<img src=x onerror="alert(1)"><script>alert(1)</script>';
      await page.goto(`/sign-in?prompt=${encodeURIComponent(rawHtmlPayload)}`, {
        waitUntil: "domcontentloaded",
      });

      const continueAsGuest = page.getByRole("link", { name: /continue as guest/i });
      await expectSafeRelativeHref(continueAsGuest, "/chat");
      await expect(page.locator("img[onerror]")).toHaveCount(0);
      await expectNoInjectedScripts(page);
      await expectNoUnsafeDom(page);
      await expectNoDialogs(dialogs);
    });
  });

  test.describe("Content injection via page rendering", () => {
    test("HTML entities are escaped in rendered pages", async ({ page }) => {
      const dialogs = registerDialogFailure(page);
      await page.goto(
        `/sign-in?error=${encodeURIComponent("<b>bold</b>")}`,
        { waitUntil: "domcontentloaded" }
      );

      await expect(page.locator("b", { hasText: "bold" })).toHaveCount(0);
      await expectNoInjectedScripts(page);
      await expectNoUnsafeDom(page);
      await expectNoDialogs(dialogs);
    });

    test("script injection via hash fragment is blocked", async ({
      page,
    }) => {
      const dialogs = registerDialogFailure(page);
      await page.goto('/chat#<script>alert(1)</script><img src=x onerror=alert(1)>', {
        waitUntil: "domcontentloaded",
      });

      await expectNoInjectedScripts(page);
      await expectNoUnsafeDom(page);
      await expectNoDialogs(dialogs);
    });
  });

  test.describe("dangerouslySetInnerHTML audit", () => {
    test("inline scripts exactly match the active CSP nonce policy", async ({
      page,
      request,
    }) => {
      await page.goto("/", { waitUntil: "domcontentloaded" });

      const response = await request.get("/");
      const csp = response.headers()["content-security-policy"] ?? "";
      const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? "";
      const inlineScripts = await page.locator("head script:not([src])").evaluateAll((scripts) =>
        scripts.map((script) => ({
          nonce: script.getAttribute("nonce"),
          text: script.textContent ?? "",
        }))
      );

      expect(inlineScripts.map((script) => script.text)).toEqual([
        expect.stringContaining("localStorage.getItem('eco-theme')"),
        expect.stringContaining("addEventListener('error'"),
      ]);

      if (scriptSrc.includes("'unsafe-eval'")) {
        expect(scriptSrc).toContain("'unsafe-inline'");
        expect(scriptSrc).not.toContain("'nonce-");
        expect(inlineScripts.map((script) => script.nonce)).toEqual([null, null]);
        return;
      }

      const cspNonce = scriptSrc.match(/'nonce-([^']+)'/)?.[1] ?? "";
      expect(cspNonce.length).toBeGreaterThan(0);
      expect(scriptSrc).toContain("'strict-dynamic'");
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(inlineScripts.map((script) => script.nonce)).toEqual([cspNonce, cspNonce]);
    });
  });
});
