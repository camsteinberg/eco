// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export const ACTIVE_CONVERSATION_STORAGE_KEY = "eco-active-conversation";
export const COMPOSER_DRAFT_STORAGE_KEY = "eco-composer-draft";
/**
 * Marks that the blank chat on screen is a deliberate "New chat", not the
 * absence of a saved conversation. Both look identical in
 * `ACTIVE_CONVERSATION_STORAGE_KEY` (the key is simply gone), and only the
 * second one should reopen the most recent conversation on the next load.
 */
export const NEW_CHAT_STORAGE_KEY = "eco-new-chat";
