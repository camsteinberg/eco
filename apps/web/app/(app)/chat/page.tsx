// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { Suspense } from "react";
import type { Metadata } from "next";
import { ChatPageClient } from "../../../src/components/chat/ChatPageClient";

// Mirrors the inherited root title so the document title is unchanged while
// keeping metadata declared at the route level for the server component.
export const metadata: Metadata = {
  title: "Eco — AI that respects you and the planet",
};

export default function ChatPage() {
  return (
    <Suspense>
      <ChatPageClient />
    </Suspense>
  );
}
