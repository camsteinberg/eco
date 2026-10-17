// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import {
  REPORT_JSON_PATH,
  buildReport,
  describeBrowser,
  renderMarkdown,
  reportArtefacts,
  type BrowserIdentity,
} from "../lib/report";
import { FIXTURE_OPTIONS, FIXTURE_PICKS } from "./report-fixture";
import golden from "./report-golden.json";

/**
 * `report-golden.json` was captured from the report code as it stood BEFORE the
 * `browser` field and named artefacts were added (main 4cdf42b), by assembling
 * these fixture walks from disk. A Chrome run's report must stay byte-identical
 * to it: the field exists only for runs in another browser.
 */
describe("a Chrome run's report is unchanged", () => {
  for (const [name, options] of Object.entries(FIXTURE_OPTIONS)) {
    const expected = golden[name as keyof typeof golden];

    it(`${name}: the JSON artefact is byte-identical`, () => {
      const report = buildReport([...FIXTURE_PICKS], options);
      expect(`${JSON.stringify(report, null, 2)}\n`).toBe(expected.json);
    });

    it(`${name}: the Markdown artefact is byte-identical`, () => {
      expect(renderMarkdown(buildReport([...FIXTURE_PICKS], options))).toBe(expected.markdown);
    });
  }

  it("keeps the default artefact paths", () => {
    const artefacts = reportArtefacts();
    expect(artefacts.jsonPath).toBe(REPORT_JSON_PATH);
    expect(artefacts.markdownPath).toBe(REPORT_JSON_PATH.replace(/\.json$/, ".md"));
    expect(artefacts.fragmentDir.endsWith("/test-results/acceptance-picks")).toBe(true);
  });
});

describe("a run in another browser", () => {
  const MAC: BrowserIdentity = { engine: "safari", device: "mac", version: "26.4" };
  const IPHONE: BrowserIdentity = {
    engine: "safari",
    device: "ios",
    version: "26.1",
    deviceName: "Test iPhone",
    osVersion: "26.1",
  };

  it("names the browser and device", () => {
    expect(describeBrowser(MAC)).toBe("Safari 26.4 on Mac");
    expect(describeBrowser(IPHONE)).toBe("Safari 26.1 on iPhone (Test iPhone, iOS 26.1)");
  });

  it("carries the browser in the JSON and names it in the header and every table title", () => {
    const report = buildReport([...FIXTURE_PICKS], { smoke: true, tasks: [1], browser: MAC });
    expect(report.browser).toEqual(MAC);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("**Real browser: Safari 26.4 on Mac.**");
    expect(markdown).toContain(
      "## Eco Fast (`candidate/lfm2.5-1.2b-instruct-onnx`, slot `eco-fast`) — Safari 26.4 on Mac",
    );
    expect(markdown).toContain(
      "## Eco Deeper (`candidate/lfm2-2.6b-onnx`, slot `eco-smart`) — Safari 26.4 on Mac",
    );
  });

  it("says how a Safari run differs, and never the Chrome lane's profile or interception wording", () => {
    const markdown = renderMarkdown(buildReport([...FIXTURE_PICKS], { smoke: true, tasks: [1, 2, 12], browser: MAC }));
    expect(markdown).toContain(
      "one model, tasks 1, 2 and 12 only, in a fresh Safari profile.** This run is not an acceptance verdict",
    );
    expect(markdown).toContain("driven over WebDriver (`safaridriver`)");
    expect(markdown).toContain("task 1's time includes that download");
    expect(markdown).toContain("The build's `API_URL` points at a stub the");
    expect(markdown).not.toContain("on whatever the profile already had");
    expect(markdown).not.toContain("Its request is\nintercepted");
  });

  it("writes to its own artefacts, so it never overwrites the Chrome report", () => {
    const chrome = reportArtefacts();
    const safari = reportArtefacts("safari-ios");
    expect(safari.jsonPath.endsWith("/test-results/acceptance-report-safari-ios.json")).toBe(true);
    expect(safari.markdownPath.endsWith("/test-results/acceptance-report-safari-ios.md")).toBe(true);
    expect(safari.fragmentDir.endsWith("/test-results/acceptance-picks-safari-ios")).toBe(true);
    expect(safari.jsonPath).not.toBe(chrome.jsonPath);
    expect(safari.fragmentDir).not.toBe(chrome.fragmentDir);
  });
});
