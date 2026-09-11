// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The composer's Web switch.
 *
 * Two things matter here: the switch reports its state honestly to assistive
 * technology (a person must be able to tell whether their questions can leave
 * the device), and it is the SAME setting as the Settings → Eco row, so the two
 * switches can never disagree.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { WebSearchToggle } from "../WebSearchToggle";
import { SettingsSwitch } from "../../settings/SettingsSwitch";
import { useSettingsStore } from "../../../stores/settingsStore";

// The setter writes through to IndexedDB; the DB layer is irrelevant here.
vi.mock("../../../lib/settings-db", () => ({
  openSettingsDB: vi.fn(async () => {
    throw new Error("no db in jsdom");
  }),
  encryptSetting: vi.fn((value: string) => ({ ciphertext: `enc:${value}`, nonce: "nonce" })),
  decryptSetting: vi.fn((ciphertext: string) => ciphertext.replace(/^enc:/, "")),
  ensureSettingsKey: vi.fn(async () => new Uint8Array(32)),
}));

/** The Settings → Eco row, bound exactly as `SettingsEcoTab` binds it. */
function SettingsRowSwitch() {
  const webSearchEnabled = useSettingsStore((s) => s.webSearchEnabled);
  const setWebSearchEnabled = useSettingsStore((s) => s.setWebSearchEnabled);
  return (
    <SettingsSwitch
      checked={webSearchEnabled}
      onChange={setWebSearchEnabled}
      ariaLabel="Toggle web search"
    />
  );
}

beforeEach(() => {
  useSettingsStore.setState({ webSearchEnabled: false });
});

describe("WebSearchToggle", () => {
  it("renders an off switch by default and names its state", () => {
    render(<WebSearchToggle />);

    const toggle = screen.getByTestId("web-search-toggle");
    expect(toggle).toHaveAttribute("role", "switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleName("Web search: off");
    expect(toggle).toHaveAttribute(
      "title",
      "When on, Eco searches the web for questions about right now. Only the search terms go to Eco's relay.",
    );
    expect(toggle).toHaveTextContent("Web");
  });

  it("flips the persisted setting and its accessible name on click", async () => {
    const user = userEvent.setup();
    render(<WebSearchToggle />);
    const toggle = screen.getByTestId("web-search-toggle");

    await user.click(toggle);

    expect(useSettingsStore.getState().webSearchEnabled).toBe(true);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleName("Web search: on");

    await user.click(toggle);

    expect(useSettingsStore.getState().webSearchEnabled).toBe(false);
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("is visible at every width — no `hidden` breakpoint gate on the control", () => {
    render(<WebSearchToggle />);
    expect(screen.getByTestId("web-search-toggle").className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it("shares one setting with the Settings row switch — either moves both", async () => {
    const user = userEvent.setup();
    render(
      <>
        <WebSearchToggle />
        <SettingsRowSwitch />
      </>,
    );
    const composer = screen.getByTestId("web-search-toggle");
    const settingsRow = screen.getByRole("switch", { name: "Toggle web search" });

    await user.click(settingsRow);
    expect(composer).toHaveAttribute("aria-checked", "true");
    expect(settingsRow).toHaveAttribute("aria-checked", "true");

    await user.click(composer);
    expect(composer).toHaveAttribute("aria-checked", "false");
    expect(settingsRow).toHaveAttribute("aria-checked", "false");
    expect(useSettingsStore.getState().webSearchEnabled).toBe(false);
  });
});
