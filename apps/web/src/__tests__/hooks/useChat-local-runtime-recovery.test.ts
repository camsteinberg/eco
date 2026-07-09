// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { getLocalRuntimeCrashRecovery } from "../../hooks/useChat";

describe("getLocalRuntimeCrashRecovery", () => {
  it("keeps partial crash recovery on-device with no network references", () => {
    const recovery = getLocalRuntimeCrashRecovery(true);

    expect(recovery.shouldSwitchToNetwork).toBe(false);
    expect(recovery.globalError).toContain("try again to keep going on this device");
    expect(recovery.globalError).not.toContain("Eco Network");
    expect(recovery.assistantUpdate).toMatchObject({
      status: "complete",
      streamInterrupted: true,
      inferenceMethod: "local",
    });
  });

  it("keeps failed local turns user-controlled and on-device when no partial response exists", () => {
    const recovery = getLocalRuntimeCrashRecovery(false);

    expect(recovery.shouldSwitchToNetwork).toBe(false);
    expect(recovery.globalError).not.toContain("Eco Network");
    expect(recovery.assistantUpdate).toMatchObject({
      status: "error",
      inferenceMethod: "local",
    });
    const errorMessage =
      "errorMessage" in recovery.assistantUpdate
        ? recovery.assistantUpdate.errorMessage
        : "";
    expect(errorMessage).toContain("Try again on this device");
    expect(errorMessage).not.toContain("Eco Network");
  });
});
