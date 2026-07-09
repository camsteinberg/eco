// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { ChatWorkspace } from "./ChatWorkspace";
import { useConversationStore } from "../../stores/conversationStore";
import { LocalAiSetupGate } from "../local-ai/LocalAiSetupGate";
import {
  normalizePendingChatPrompt,
  rememberPendingChatPrompt,
} from "../../lib/pending-chat-prompt";
import { syncCaptureFlagFromUrl } from "../../lib/dev-capture";

function ChatPageInner() {
  const searchParams = useSearchParams();
  const hasHydrated = useConversationStore((s) => s.hasHydrated);
  const promptParam = normalizePendingChatPrompt(searchParams.get("prompt"));

  useEffect(() => {
    if (promptParam) {
      rememberPendingChatPrompt(promptParam);
    }
  }, [promptParam]);

  // Persist ?eco-capture=1/0 into the sticky dev-capture flag (dogfooding —
  // gates the "Flag for eval" affordance on assistant messages).
  useEffect(() => {
    syncCaptureFlagFromUrl();
  }, []);

  if (!hasHydrated) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--eco-surface-chat)]">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--eco-primary)] border-t-transparent" />
      </div>
    );
  }

  return <ChatWorkspace />;
}

/**
 * Client entry point for the /chat route. Wraps the workspace in the on-device
 * setup gate and defers rendering until the conversation store has hydrated.
 * Rendered by the server `page.tsx` inside a Suspense boundary so the
 * `useSearchParams()` calls below are isolated to the client.
 */
export function ChatPageClient() {
  return (
    <LocalAiSetupGate
      onBelowFloorSignup={async (email) => {
        if (typeof window !== "undefined") {
          const subject = encodeURIComponent("Eco interest");
          const body = encodeURIComponent(
            `Email: ${email}\n\nReach out when Eco supports this device.`,
          );
          window.location.href = `mailto:hello@econetwork.ai?subject=${subject}&body=${body}`;
        }
      }}
      onTellUsMore={() => {
        // Without this prop the gate's default is a silent no-op — the
        // "Tell us more" button did nothing in prod. Route to the
        // diagnostics surface so it actually shows what happened.
        if (typeof window !== "undefined") {
          window.location.assign("/diagnostics/local-ai?eco-diagnostics=1");
        }
      }}
    >
      <ChatPageInner />
    </LocalAiSetupGate>
  );
}
