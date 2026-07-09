// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it } from "vitest";
import { staticAssetRecoveryScript } from "../static-asset-recovery-script";

describe("staticAssetRecoveryScript", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-eco-asset-load-failed");
    document.documentElement.style.removeProperty("--eco-css-ready");
    sessionStorage.clear();
    history.replaceState(null, "", "/chat");
  });

  it("shows the recovery overlay when a stale page loads without app CSS after one retry", async () => {
    document.head.innerHTML = '<link rel="stylesheet" href="/_next/static/css/missing.css">';
    sessionStorage.setItem("eco-static-asset-recovery:/chat", "attempted");

    new Function(staticAssetRecoveryScript)();
    window.dispatchEvent(new Event("load"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.getElementById("eco-static-asset-recovery")).toBeInTheDocument();
    expect(document.body).toHaveTextContent("Eco could not load its latest app files.");
    expect(document.getElementById("eco-static-asset-recovery")).toHaveAttribute(
      "aria-labelledby",
      "eco-static-asset-recovery-title",
    );
    expect(document.getElementById("eco-static-asset-retry")).toHaveFocus();
  });

  it("clears the recovery retry marker when app CSS is present", async () => {
    document.head.innerHTML = '<link rel="stylesheet" href="/_next/static/css/app.css">';
    document.documentElement.style.setProperty("--eco-css-ready", "1");
    sessionStorage.setItem("eco-static-asset-recovery:/chat", "attempted");

    new Function(staticAssetRecoveryScript)();
    window.dispatchEvent(new Event("load"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.getElementById("eco-static-asset-recovery")).not.toBeInTheDocument();
    expect(sessionStorage.getItem("eco-static-asset-recovery:/chat")).toBeNull();
  });
});
