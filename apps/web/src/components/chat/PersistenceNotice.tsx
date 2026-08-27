// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { ErrorNotice } from "../ui/ErrorNotice";
import { useConversationStore } from "../../stores/conversationStore";

/**
 * The chat-side surface for a failed conversation save.
 *
 * `conversationStore` records a save failure in `persistenceError`, and the
 * sidebar's conversation list shows it. On a phone that list lives in a closed
 * bottom sheet, so a person could keep chatting for an hour into a
 * conversation that stopped being written to disk and never see a word about
 * it. This puts the same message by the composer, on every screen size, with
 * the same dismiss. Both surfaces read and clear one store field, so they
 * never disagree.
 */
export function PersistenceNotice({ className = "" }: { className?: string }) {
  const persistenceError = useConversationStore((s) => s.persistenceError);
  const clear = useConversationStore((s) => s.clearPersistenceError);
  if (!persistenceError) return null;
  return (
    <ErrorNotice
      className={className}
      lead={persistenceError}
      onDismiss={clear}
    />
  );
}
