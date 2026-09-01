// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Shared user-facing error messages for the local-AI adapter layer.
 *
 * Centralised here so that `useChat.ts` and `runtime/stream.ts` reference
 * the same string — preventing drift between the two call sites.
 */

export const TEMPLATE_MISSING_USER_MESSAGE =
  "This model's chat template is missing or broken. Open Settings → Eco to re-download it, or pick a different model.";

/**
 * Warm fallback for on-device generation failures that don't match a dedicated,
 * already-crafted branch (unknown runtime error codes / untyped failures). The
 * raw technical detail is logged for diagnostics — never shown to the user, who
 * only ever saw an opaque string like "boom" or "No model loaded" before.
 */
export const LOCAL_GENERATION_FALLBACK_MESSAGE =
  "On-device AI hit a snag. Your conversation is safe — try sending your message again.";

/**
 * Escalated copy for a SECOND consecutive on-device generation failure on the
 * same model. By this point the runtime has reset the dead adapter (see
 * lifecycle.ts fault-unload), so the honest message is "we reset it, and if it
 * keeps happening a lighter model may help" — paired with the lighter-model
 * nudge ErrorMessage renders only for this exact string.
 */
export const LOCAL_GENERATION_REPEATED_MESSAGE =
  "On-device AI hit the same snag again. Eco reset the model for a fresh start — if it keeps happening, a lighter model may run better on this device.";

/**
 * Warm copy for a recoverable on-device runtime hiccup where the turn can be
 * retried in place (no partial content). Kept byte-identical to the literal
 * chat-recovery.ts persists onto the assistant message, so ErrorMessage's
 * exact-string match keeps working for already-saved conversations.
 */
export const LOCAL_RUNTIME_HICCUP_MESSAGE =
  "On-device AI needed a moment. Try again on this device to pick up where you left off.";

/** Warm cooldown copy for when the remaining time can't be recovered cleanly. */
export const LOCAL_COOLDOWN_MESSAGE =
  "On-device AI needs a short breather after a snag. Give it a moment, then send your message again.";

/**
 * Copy for the DEVICE_PROTECTION fault: the battery is low, so on-device work is
 * paused to protect the device. Named (rather than inlined at the throw site) so
 * ErrorMessage can match it exactly — its wording contains both "on-device" and
 * "locally", which would otherwise trip the setup-error regex and mislabel a flat
 * battery as a setup step the user skipped.
 */
export const DEVICE_PROTECTION_MESSAGE =
  "Battery is low, so Eco paused on-device AI to protect this device. Plug in, then try again to keep chatting locally.";

/**
 * Copy for the GPU_BUSY_OTHER_TAB gate: another browser tab already owns the
 * on-device model, so this tab can't load its own without risking the WebGPU
 * device-loss crash the single-tab ownership lock prevents. Named (rather than
 * inlined) so ErrorMessage can match it exactly — the wording contains
 * "on-device", which would otherwise trip the setup regex and mislabel it as
 * "Eco needs one quick setup". Recoverable: closing the other tab and retrying
 * succeeds.
 */
export const LOCAL_MODEL_OTHER_TAB_MESSAGE =
  "Eco's on-device AI is running in another browser tab. Switch to that tab to keep chatting, or close it and try again here.";

/**
 * Copy for the MODEL_FILES_MISSING fault: the browser evicted this model's
 * weight files (storage pressure, Safari's storage cap, a cache clear) and Eco
 * could not fetch them again. Two wordings — the offline one says plainly why a
 * retry can't work yet. Both are matched by exact string in ErrorMessage: the
 * copy says "download", which the setup regex would otherwise relabel "Eco
 * needs one quick setup" and hide Try again.
 */
export const LOCAL_MODEL_FILES_MISSING_OFFLINE_MESSAGE =
  "This model's files are no longer on this device, and Eco can't download them again while you're offline. Reconnect, then try again — Eco will fetch a fresh copy.";

export const LOCAL_MODEL_FILES_MISSING_MESSAGE =
  "This model's files are no longer on this device, and downloading a fresh copy didn't work. Check your connection, then try again.";

/**
 * The runtime's cooldown error embeds the real remaining time as "(Ns left)"
 * (runtime/lifecycle.ts builds it). Recover that number from our own controlled
 * message so the warm copy keeps the honest countdown instead of inventing one
 * — and phrase it in a friendly unit (the cooldown runs up to 5 minutes, so raw
 * "300 seconds" would read badly). Falls back to LOCAL_COOLDOWN_MESSAGE when the
 * marker is absent, so no fake precision is ever shown.
 */
const COOLDOWN_REMAINING_PATTERN = /\((\d+)s left\)/;

function describeWait(count: number, unit: "minute" | "second"): string {
  return `about ${String(count)} ${unit}${count === 1 ? "" : "s"}`;
}

export function describeLocalCooldownMessage(rawMessage: string): string {
  const match = COOLDOWN_REMAINING_PATTERN.exec(rawMessage);
  const remainingSec = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(remainingSec) || remainingSec <= 0) {
    return LOCAL_COOLDOWN_MESSAGE;
  }

  const wait =
    remainingSec >= 60
      ? describeWait(Math.ceil(remainingSec / 60), "minute")
      : describeWait(remainingSec, "second");

  return `On-device AI needs a short breather after a snag — try again in ${wait}.`;
}
