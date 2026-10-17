// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * A minimal W3C WebDriver client for safaridriver, over plain HTTP.
 *
 * Playwright cannot drive real Safari: its WebKit is not Safari, and its GPU
 * path is not Safari's. Apple's `safaridriver` can — for desktop Safari, and
 * for Safari on an iPhone plugged in over USB — and speaks WebDriver, which is
 * a handful of JSON endpoints. This file is those endpoints and nothing more.
 */

/** The W3C key a found element's reference travels under. */
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

/** A WebDriver error, with the one distinction the walk acts on. */
export class WebDriverError extends Error {
  /**
   * The session is gone. On Safari this is what a killed tab looks like (the
   * whole automation window goes with it), so the walk stops rather than
   * failing every later step one timeout at a time.
   */
  readonly sessionDied: boolean;

  constructor(message: string, sessionDied: boolean) {
    super(message);
    this.name = "WebDriverError";
    this.sessionDied = sessionDied;
  }
}

/** Whether an error means the WebDriver session itself has ended. */
export function isSessionDeath(error: unknown): boolean {
  return error instanceof WebDriverError && error.sessionDied;
}

type WireResponse = { value?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function call(
  driverUrl: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs = 60_000,
): Promise<unknown> {
  const response = await fetch(`${driverUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await response.json().catch(() => ({}))) as WireResponse;
  if (!response.ok) {
    const detail = JSON.stringify(json.value ?? json).slice(0, 400);
    const message = `${method} ${path} → ${response.status} ${detail}`;
    throw new WebDriverError(message, /invalid session id/i.test(detail));
  }
  return json.value;
}

/** safaridriver is listening and ready for a new session. */
export async function driverReady(driverUrl: string): Promise<boolean> {
  try {
    const value = await call(driverUrl, "GET", "/status", undefined, 5_000);
    return isRecord(value) && value.ready === true;
  } catch {
    return false;
  }
}

export type SafariSession = {
  id: string;
  /** What the driver reported about the browser it started. */
  capabilities: Record<string, unknown>;
  navigate: (url: string) => Promise<void>;
  /**
   * Run `fn` inside the page with `args`, and return its (awaited) result.
   *
   * `fn` must be self-contained — it travels as source text, exactly as it
   * does through Playwright's `page.evaluate` (see `../lib/in-page`). The
   * result crosses back as JSON, so it must be JSON-shaped.
   */
  run: <A extends unknown[], R>(fn: (...args: A) => R | Promise<R>, ...args: A) => Promise<R>;
  /** A CSS selector's first match, or null. */
  find: (css: string) => Promise<string | null>;
  /** A real WebDriver click on an element reference. */
  click: (element: string) => Promise<void>;
  windowHandle: () => Promise<string>;
  /** Open a new tab and return its handle. The current tab stays current. */
  newTab: () => Promise<string>;
  switchTo: (handle: string) => Promise<void>;
  /** Close the CURRENT tab. Switch to another one afterwards. */
  closeCurrentTab: () => Promise<void>;
  /** End the session. Never throws: a session that already died is already ended. */
  end: () => Promise<void>;
};

/**
 * Wrap `fn` for the async execute endpoint: call it with the arguments, await
 * it, and hand back JSON (or the error's text) through the driver's callback.
 */
function asyncScript(fn: (...args: never[]) => unknown): string {
  return [
    "const done = arguments[arguments.length - 1];",
    "const args = Array.prototype.slice.call(arguments, 0, -1);",
    `Promise.resolve().then(() => (${fn.toString()}).apply(null, args))`,
    "  .then((value) => done({ json: value === undefined ? null : JSON.stringify(value) }),",
    "        (error) => done({ error: String(error && error.stack || error) }));",
  ].join("\n");
}

export async function createSession(
  driverUrl: string,
  alwaysMatch: Record<string, unknown>,
): Promise<SafariSession> {
  let created: unknown;
  try {
    created = await call(driverUrl, "POST", "/session", { capabilities: { alwaysMatch } }, 120_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/paired/i.test(message)) {
      throw new Error(
        `safaridriver says Safari is 'already paired' with another session: stop the :4444 listener `
          + `and safaridriver, start \`safaridriver -p 4444\` again, and retry. (${message})`,
      );
    }
    throw error;
  }
  if (!isRecord(created) || typeof created.sessionId !== "string") {
    throw new Error(`safaridriver returned no session id: ${JSON.stringify(created).slice(0, 200)}`);
  }
  const id = created.sessionId;
  const capabilities = isRecord(created.capabilities) ? created.capabilities : {};
  const at = (path: string) => `/session/${id}${path}`;

  await call(driverUrl, "POST", at("/timeouts"), { script: 120_000, pageLoad: 300_000 });

  return {
    id,
    capabilities,
    navigate: async (url) => {
      await call(driverUrl, "POST", at("/url"), { url }, 300_000);
    },
    run: async <A extends unknown[], R>(fn: (...args: A) => R | Promise<R>, ...args: A) => {
      const value = await call(
        driverUrl,
        "POST",
        at("/execute/async"),
        { script: asyncScript(fn as (...args: never[]) => unknown), args },
        130_000,
      );
      if (isRecord(value) && typeof value.error === "string") {
        throw new Error(`in-page ${fn.name || "function"} threw: ${value.error.slice(0, 300)}`);
      }
      if (!isRecord(value) || !("json" in value)) {
        throw new Error(`in-page ${fn.name || "function"} returned no result: ${JSON.stringify(value).slice(0, 200)}`);
      }
      return (typeof value.json === "string" ? JSON.parse(value.json) : undefined) as R;
    },
    find: async (css) => {
      try {
        const found = await call(driverUrl, "POST", at("/element"), { using: "css selector", value: css });
        return isRecord(found) && typeof found[ELEMENT_KEY] === "string" ? found[ELEMENT_KEY] : null;
      } catch (error) {
        if (isSessionDeath(error)) throw error;
        return null;
      }
    },
    click: async (element) => {
      await call(driverUrl, "POST", at(`/element/${element}/click`), {});
    },
    windowHandle: async () => String(await call(driverUrl, "GET", at("/window"))),
    newTab: async () => {
      const value = await call(driverUrl, "POST", at("/window/new"), { type: "tab" });
      if (!isRecord(value) || typeof value.handle !== "string") {
        throw new Error(`safaridriver opened no tab: ${JSON.stringify(value).slice(0, 200)}`);
      }
      return value.handle;
    },
    switchTo: async (handle) => {
      await call(driverUrl, "POST", at("/window"), { handle });
    },
    closeCurrentTab: async () => {
      await call(driverUrl, "DELETE", at("/window"));
    },
    end: async () => {
      await call(driverUrl, "DELETE", `/session/${id}`, undefined, 15_000).catch(() => undefined);
    },
  };
}
