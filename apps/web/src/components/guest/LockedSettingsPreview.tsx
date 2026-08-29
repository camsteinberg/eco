// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useState } from "react";
import type { GuestLockedSettingsTabId } from "../../lib/access-policy";
import { AccountRequiredDialog } from "./AccountRequiredDialog";
import { SettingsSection } from "../settings/SettingsSection";

type LockedSettingsPreviewProps = {
  tab: GuestLockedSettingsTabId;
  callbackUrl: string;
};

type LockedCopy = {
  title: string;
  body: string;
  /** Title used for the sign-in dialog (a fuller sentence). */
  dialogTitle: string;
  /** Description used for the sign-in dialog. */
  dialogDescription: string;
};

const LOCKED_COPY: Record<GuestLockedSettingsTabId, LockedCopy> = {
  account: {
    title: "Your account",
    body: "Sign in to manage your profile and account deletion.",
    dialogTitle: "Sign in to use your account",
    dialogDescription:
      "Profile and account controls live here once this workspace belongs to you.",
  },
  billing: {
    title: "Plan & billing",
    body: "Local AI stays free for everyone. Sign in to see your membership and become a Supporter when you're ready.",
    dialogTitle: "Sign in to manage billing",
    dialogDescription:
      "Membership, invoices, and Supporter benefits stay attached to your account after you sign in.",
  },
};

export function LockedSettingsPreview({
  tab,
  callbackUrl,
}: LockedSettingsPreviewProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const copy = LOCKED_COPY[tab];

  return (
    <>
      <SettingsSection title={copy.title} description={copy.body} hairline={false}>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="inline-flex min-h-11 items-center justify-center rounded-xl px-4 py-2.5 text-sm font-medium text-[var(--eco-on-primary)] transition-all hover:opacity-95"
          style={{ backgroundColor: "var(--eco-primary)" }}
        >
          Sign in
        </button>
      </SettingsSection>

      <AccountRequiredDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={copy.dialogTitle}
        description={copy.dialogDescription}
        callbackUrl={callbackUrl}
      />
    </>
  );
}
