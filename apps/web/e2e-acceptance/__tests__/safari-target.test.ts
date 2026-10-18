// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { identityFromCapabilities } from "../safari/identity";
import {
  BASE_URL_ENV_VAR,
  DEFAULT_DRIVER_URL,
  DEFAULT_STUB_PORT,
  SAFARI_TASKS,
  STUB_PORT_ENV_VAR,
  TARGET_ENV_VAR,
  TASKS_ENV_VAR,
  artefactName,
  safariLaneConfig,
} from "../safari/target";

const MAC = { [TARGET_ENV_VAR]: "mac", [BASE_URL_ENV_VAR]: "http://127.0.0.1:3132/" };

describe("safariLaneConfig", () => {
  it("reads a Mac run with the defaults", () => {
    expect(safariLaneConfig(MAC)).toEqual({
      target: "mac",
      baseUrl: "http://127.0.0.1:3132",
      driverUrl: DEFAULT_DRIVER_URL,
      stubPort: DEFAULT_STUB_PORT,
      tasks: SAFARI_TASKS,
      narrowed: true,
    });
  });

  it("requires a target, by name", () => {
    expect(() => safariLaneConfig({ [BASE_URL_ENV_VAR]: "http://127.0.0.1:3132" })).toThrow(/ECO_SAFARI_TARGET/);
    expect(() => safariLaneConfig({ ...MAC, [TARGET_ENV_VAR]: "safari" })).toThrow(/"mac".*"ios"/);
  });

  it("requires a base URL", () => {
    expect(() => safariLaneConfig({ [TARGET_ENV_VAR]: "mac" })).toThrow(/ECO_SAFARI_BASE_URL/);
  });

  it("keeps a Mac run on loopback, where the harness is on", () => {
    expect(safariLaneConfig({ ...MAC, [BASE_URL_ENV_VAR]: "http://localhost:3133" }).baseUrl).toBe(
      "http://localhost:3133",
    );
    expect(() => safariLaneConfig({ ...MAC, [BASE_URL_ENV_VAR]: "http://192.168.1.201:3132" })).toThrow(
      /loopback/,
    );
  });

  it("keeps an iPhone run on https off loopback", () => {
    const ios = { [TARGET_ENV_VAR]: "ios", [BASE_URL_ENV_VAR]: "https://192.168.1.201:3443" };
    expect(safariLaneConfig(ios).baseUrl).toBe("https://192.168.1.201:3443");
    expect(() => safariLaneConfig({ ...ios, [BASE_URL_ENV_VAR]: "http://192.168.1.201:3443" })).toThrow(/https/);
    expect(() => safariLaneConfig({ ...ios, [BASE_URL_ENV_VAR]: "https://127.0.0.1:3443" })).toThrow(/https/);
  });

  it("narrows to the tasks asked for, in the walk's own order", () => {
    expect(safariLaneConfig({ ...MAC, [TASKS_ENV_VAR]: "12, 1" }).tasks).toEqual([1, 12]);
  });

  it("refuses a task it has no Safari mechanism for, by number", () => {
    expect(() => safariLaneConfig({ ...MAC, [TASKS_ENV_VAR]: "1,7" })).toThrow(/task\(s\) 7/);
    expect(() => safariLaneConfig({ ...MAC, [TASKS_ENV_VAR]: "8" })).toThrow(/task\(s\) 8/);
  });

  it("walks every task but the offline reload and the model switch, in the walk's order", () => {
    expect(SAFARI_TASKS).toEqual([1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14]);
    expect(safariLaneConfig({ ...MAC, [TASKS_ENV_VAR]: "14,9,3" }).tasks).toEqual([3, 9, 14]);
  });

  it("reads the stub port, and refuses a bad one", () => {
    expect(safariLaneConfig({ ...MAC, [STUB_PORT_ENV_VAR]: "3139" }).stubPort).toBe(3139);
    expect(() => safariLaneConfig({ ...MAC, [STUB_PORT_ENV_VAR]: "nope" })).toThrow(/not a port/);
  });

  it("names its artefacts per target", () => {
    expect(artefactName("mac")).toBe("safari-mac");
    expect(artefactName("ios")).toBe("safari-ios");
  });
});

describe("identityFromCapabilities", () => {
  it("reads desktop Safari's capabilities", () => {
    expect(identityFromCapabilities("mac", { browserName: "Safari", browserVersion: "26.4" })).toEqual({
      engine: "safari",
      device: "mac",
      version: "26.4",
    });
  });

  it("reads an iPhone's name and iOS version", () => {
    expect(
      identityFromCapabilities("ios", {
        browserVersion: "26.1",
        "safari:deviceName": "Test iPhone",
        "safari:platformVersion": "26.1",
      }),
    ).toEqual({ engine: "safari", device: "ios", version: "26.1", deviceName: "Test iPhone", osVersion: "26.1" });
  });

  it("says unknown rather than inventing a version", () => {
    expect(identityFromCapabilities("mac", {}).version).toBe("unknown");
  });
});
