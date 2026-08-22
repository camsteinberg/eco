// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { ReactNode } from "react";
import { isBillingUiEnabled } from "../../lib/billing-ui-gate";

export const DEFAULT_SETTINGS_TAB = "account" as const;

export type SettingsTabId =
  | "account"
  | "support"
  | "billing"
  | "models"
  | "appearance";

/**
 * Legacy `?tab=` values that no longer have a dedicated tab. They are folded
 * into a surviving tab and resolved to it so deep links never 404.
 *
 * - `instructions` (custom instructions) folded into the Eco tab.
 * - `privacy` retired — the dedicated /privacy + /transparency pages tell that
 *   story; a brief on-device note lives in the Eco tab.
 * - `integrations` retired — every toggle was dead, deferred-feature surface.
 */
const RETIRED_SETTINGS_TAB_REDIRECTS: Readonly<Record<string, SettingsTabId>> = {
  instructions: "models",
  privacy: "models",
  integrations: "models",
};

export type SidebarSettingsSection = "account" | "support" | "billing" | "models" | "appearance";

export const SETTINGS_TABS: ReadonlyArray<{
  id: SettingsTabId;
  label: string;
  icon: ReactNode;
  sidebarSection: SidebarSettingsSection;
}> = [
  {
    id: "account",
    label: "Account",
    sidebarSection: "account",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0">
        <path d="M10 8a3 3 0 100-6 3 3 0 000 6zM3.465 14.493a1.23 1.23 0 00.41 1.412A9.957 9.957 0 0010 18c2.31 0 4.438-.784 6.131-2.1.43-.333.604-.903.408-1.41a7.002 7.002 0 00-13.074.003z" />
      </svg>
    ),
  },
  {
    id: "support",
    label: "Support",
    sidebarSection: "support",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0">
        <path fillRule="evenodd" d="M18 10A8 8 0 112 10a8 8 0 0116 0zm-8-4a2.25 2.25 0 00-2.25 2.25.75.75 0 001.5 0 .75.75 0 111.5 0c0 .41-.25.671-.788 1.05-.67.473-1.462 1.11-1.462 2.45a.75.75 0 001.5 0c0-.59.278-.852.827-1.239l.033-.023C11.526 9.992 12.25 9.362 12.25 8.25A2.25 2.25 0 0010 6zm0 8.25a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
      </svg>
    ),
  },
  {
    id: "billing",
    label: "Billing",
    sidebarSection: "billing",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0">
        <path d="M2.5 4A1.5 1.5 0 001 5.5V6h18v-.5A1.5 1.5 0 0017.5 4h-15zM19 8.5H1v6A1.5 1.5 0 002.5 16h15a1.5 1.5 0 001.5-1.5v-6zM3 13.25a.75.75 0 01.75-.75h1.5a.75.75 0 010 1.5h-1.5a.75.75 0 01-.75-.75zm4.75-.75a.75.75 0 000 1.5h3.5a.75.75 0 000-1.5h-3.5z" />
      </svg>
    ),
  },
  {
    id: "models",
    label: "Eco",
    sidebarSection: "models",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0">
        {/* Sprout glyph — the Eco tab carries the model + personality of your AI */}
        <path d="M10 17V9" />
        <path d="M10 11C7.5 11 5.5 9 5.5 6.5C8 6.5 10 8.5 10 11Z" fill="currentColor" stroke="none" />
        <path d="M10 9C12.5 9 14.5 7 14.5 4.5C12 4.5 10 6.5 10 9Z" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    id: "appearance",
    label: "Appearance",
    sidebarSection: "appearance",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0">
        <path fillRule="evenodd" d="M1 10a9 9 0 1118 0 9 9 0 01-18 0zm9-7.5a.75.75 0 01.75.75v1a.75.75 0 01-1.5 0v-1A.75.75 0 0110 2.5zM10 15a.75.75 0 01.75.75v1a.75.75 0 01-1.5 0v-1A.75.75 0 0110 15zm-5.303-2.197a.75.75 0 010-1.06l.707-.708a.75.75 0 011.06 1.061l-.707.707a.75.75 0 01-1.06 0zM14.243 6.464a.75.75 0 010-1.06l.707-.708a.75.75 0 111.06 1.061l-.707.707a.75.75 0 01-1.06 0zM2.5 10a.75.75 0 01.75-.75h1a.75.75 0 010 1.5h-1A.75.75 0 012.5 10zM15 10a.75.75 0 01.75-.75h1a.75.75 0 010 1.5h-1A.75.75 0 0115 10zM5.404 5.404a.75.75 0 010 1.06l-.707.708a.75.75 0 01-1.06-1.061l.707-.707a.75.75 0 011.06 0zM13.536 13.536a.75.75 0 010 1.06l-.707.708a.75.75 0 01-1.06-1.061l.707-.707a.75.75 0 011.06 0z" clipRule="evenodd" />
      </svg>
    ),
  },
] as const;

/** The full tab list, including billing — used for type validation. */
export function isSettingsTab(value: string | null | undefined): value is SettingsTabId {
  return SETTINGS_TABS.some((tab) => tab.id === value);
}

/**
 * The subset of tabs that should be rendered in the current build.
 * When billing UI is disabled, the billing tab is omitted entirely.
 */
export function getVisibleSettingsTabs(): ReadonlyArray<(typeof SETTINGS_TABS)[number]> {
  if (isBillingUiEnabled()) return SETTINGS_TABS;
  return SETTINGS_TABS.filter((tab) => tab.id !== "billing");
}

export function resolveSettingsTab(value: string | null | undefined): SettingsTabId {
  if (isSettingsTab(value)) {
    // When billing UI is hidden, deep links to ?tab=billing degrade to account.
    if (value === "billing" && !isBillingUiEnabled()) {
      return DEFAULT_SETTINGS_TAB;
    }
    return value;
  }
  if (value && value in RETIRED_SETTINGS_TAB_REDIRECTS) {
    return RETIRED_SETTINGS_TAB_REDIRECTS[value]!;
  }
  return DEFAULT_SETTINGS_TAB;
}

export function buildSettingsHref(tab: SettingsTabId): string {
  return `/settings?tab=${tab}`;
}

export function resolveSidebarSettingsSection(tab: SettingsTabId): SidebarSettingsSection {
  return SETTINGS_TABS.find((settingsTab) => settingsTab.id === tab)?.sidebarSection ?? "account";
}
