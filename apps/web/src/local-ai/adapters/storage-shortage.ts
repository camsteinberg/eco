// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Does a failure reason read as a storage shortage — a failure whose fix is
 * freeing space, not retrying or waiting?
 *
 * A storage shortage surfaces as the `InsufficientStorageError` message ("Eco
 * needs about … of free space …"), and the setup cascade shows that text
 * verbatim. Both the first-run setup error surface and the in-chat prepare error
 * classify off this one regex so they can never drift into telling the same
 * failure two different stories.
 */
export function looksLikeStorageShortage(reason: string): boolean {
  return /free space|storage|not enough room|disk space/i.test(reason);
}
