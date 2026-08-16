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
import { syncDiagnosticsFlagFromUrl } from "../../lib/dev-diagnostics";
import { installPerfBridge } from "../../local-ai/diagnostics/perf-bridge";

function ChatPageInner() {
  const searchParams = useSearchParams();
  const hasHydrated = useConversationStore((s) => s.hasHydrated);
  const promptParam = normalizePendingChatPrompt(searchParams.get("prompt"));

  useEffect(() => {
    if (promptParam) {
      rememberPendingChatPrompt(promptParam);
    }
  }, [promptParam]);

  // Persist ?eco-capture=1/0 and ?eco-diagnostics=1/0 into their sticky dev
  // flags (dogfooding — gate the "Flag for eval" affordance and the settings
  // "Diagnostic info" link; the latter must survive in-app navigation so the
  // in-memory generation receipts can reach the diagnostics export).
  useEffect(() => {
    syncCaptureFlagFromUrl();
    syncDiagnosticsFlagFromUrl();
    // Read-only measurement seam for the E2E performance gate. No-ops unless
    // the validation harness is enabled (never on a production host).
    installPerfBridge();
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
