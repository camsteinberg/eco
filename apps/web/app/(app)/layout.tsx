// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { ReactNode } from "react";
import { AppShell } from "../../src/components/layout/AppShell";
import { ToastProvider } from "../../src/components/ui/Toast";
import { RetiredModelNotice } from "../../src/components/local-ai/RetiredModelNotice";

export default function ProtectedAppLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <ToastProvider>
      <RetiredModelNotice />
      <AppShell>{children}</AppShell>
    </ToastProvider>
  );
}
