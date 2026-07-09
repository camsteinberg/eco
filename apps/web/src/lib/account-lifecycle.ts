// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

let accountDeletionInProgress = false

export function setAccountDeletionInProgress(inProgress: boolean): void {
  accountDeletionInProgress = inProgress
}

export function isAccountDeletionInProgress(): boolean {
  return accountDeletionInProgress
}
