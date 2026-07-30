// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { getSlot } from "../local-ai/lifecycle/slots";
import { resolveSelectedModelId } from "../local-ai/util";
import { useChatStore } from "../stores/chatStore";

/**
 * The model id a regenerate pressed right now would actually run on.
 *
 * Mirrors the resolution `useChat.resolveDispatch` performs, including the
 * "auto" case (the store's pre-setup default, which dispatch resolves to the
 * best ready slot, eco-smart first). Only used to ask a capability question —
 * dispatch still resolves the model itself.
 *
 * It lives in its own module because TWO callers need it and they must not
 * disagree: the handler that runs a per-reply control, and the toolbar that
 * decides whether to offer that control at all. A second copy of this
 * resolution would let the toolbar show a button the handler then silently
 * refuses — a control that looks live and does nothing.
 */
export function resolveActiveModelId(): string {
  const resolved = resolveSelectedModelId(useChatStore.getState().selectedModel);
  if (resolved !== "auto") return resolved;
  for (const slotId of ["eco-smart", "eco-fast"] as const) {
    const slot = getSlot(slotId);
    if (slot.status === "ready" && slot.model) return slot.model.id;
  }
  return resolved;
}
