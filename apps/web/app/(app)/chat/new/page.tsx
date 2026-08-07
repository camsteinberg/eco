// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { startNewChat } from "../../../../src/lib/start-new-chat";

/**
 * /chat/new starts a fresh conversation, exactly like the New chat button.
 * The routine must run before we land on /chat: the restore effects there
 * reopen whatever localStorage still records as the active conversation.
 */
export default function ChatNewPage() {
  const router = useRouter();

  useEffect(() => {
    startNewChat();
    router.replace("/chat");
  }, [router]);

  return null;
}
