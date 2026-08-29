// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { createAuthClient } from 'better-auth/react'
import {
  closeConversationPersistenceDb,
  suppressNextConversationPersistenceHydration,
} from '../stores/conversationStore'
import { useConversationStore } from '../stores/conversationStore'
import { useChatStore } from '../stores/chatStore'
import { deleteAllConversations } from './history/storage'
import { clearInviteCodeCookie } from './auth-continuation'
import { clearGuestLocalContext } from './guest-local-context'
import { clearPendingChatPrompt } from './pending-chat-prompt'
import {
  requestServiceWorkerClientReset,
  suppressNextServiceWorkerRegistration,
} from './sw-register'
import { getOnboardingStore } from '../stores/onboardingStore'
import { safeStorage, STORAGE_KEYS } from './local-storage'
import { isModelCacheName } from '../local-ai/download/storage'
import { WEBLLM_CACHE_SCOPES } from '../local-ai/runtime/webllm-config'

export const authClient = createAuthClient({
  baseURL: '',
})

export const { useSession, signIn, signUp, signOut } = authClient

const USER_SIGN_OUT_TIMEOUT_MS = 10_000

/**
 * Budget for best-effort local cleanup. `clearClientState()` does best-effort
 * browser teardown (IndexedDB / localStorage / service-worker / caches); any one
 * of those awaits can stall indefinitely (e.g. a service-worker unregister that
 * never acks). That must never trap a sign-out or account-deletion flow on a
 * loading overlay, so callers bound `clearClientState()` with this budget via
 * `settleWithinBudget`.
 */
export const CLIENT_CLEANUP_BUDGET_MS = 4_000

/** Device preference keys preserved across account deletion / sign-out. */
const PRESERVED_KEYS = new Set([
  STORAGE_KEYS.THEME,
  STORAGE_KEYS.FONT_SIZE,
  'eco-sidebar-collapsed',
  'eco-selected-model',
  'eco-selected-model-explicit',
  'eco-privacy-tier',
  'eco-privacy-tier-explicit',
])

function isEcoCacheName(name: string): boolean {
  return (
    /^eco-v\d+$/.test(name)
    || /^eco-cache(?:-|$)/.test(name)
    || /^eco-app-cache(?:-|$)/.test(name)
  )
}

/**
 * Delete every Cache API namespace holding downloaded model weights: Eco's own
 * `eco-local-ai-<id>` buckets (weights AND interrupted `.ecopart.` chunk-parts
 * live in the same namespace) plus WebLLM's three private scopes.
 *
 * Deliberately NOT folded into `isEcoCacheName` — that predicate names the app
 * shell's caches and other callers rely on it staying narrow. Best-effort: every
 * call is caught individually so one rejected delete cannot trap the deletion
 * flow. Weights are gigabytes and the slow part of the sweep, so callers run
 * this BEFORE the app caches — if the cleanup budget expires mid-flight the
 * browser still finishes the deletes we already started.
 */
async function deleteModelWeightCaches(): Promise<void> {
  const names = await caches.keys().catch(() => [] as string[])
  const targets = new Set<string>(WEBLLM_CACHE_SCOPES)
  for (const name of names) {
    if (isModelCacheName(name)) {
      targets.add(name)
    }
  }
  await Promise.all(
    [...targets].map((name) => caches.delete(name).catch(() => false)),
  )
}

/**
 * Clear auth/session-bound UI state while preserving local conversation history.
 * Used when protected surfaces bounce a guest to auth or when a server session
 * expires during chat and we need to keep the local-first thread intact.
 */
export function clearUnsafeClientState(): void {
  useChatStore.getState().clearSessionState()
}

export async function bestEffortSignOut(timeoutMs = 750): Promise<void> {
  await Promise.race([
    signOut().catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs)
    }),
  ])
}

/**
 * Resolve when `work` settles or `budgetMs` elapses — whichever comes first;
 * never rejects. Used to bound best-effort local cleanup (`clearClientState`) so
 * a stalled browser-storage / service-worker teardown cannot block the caller
 * from navigating away. The privacy-critical wipes (IndexedDB conversation data,
 * localStorage) run first inside `clearClientState`, and the flaky service-worker
 * / cache teardown runs last, so resolving early on the budget is safe — the
 * subsequent full-document navigation tears down whatever remains.
 * (Mirrors `bestEffortSignOut`'s race.)
 */
export async function settleWithinBudget(
  work: Promise<unknown>,
  budgetMs: number,
): Promise<void> {
  await Promise.race([
    work.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      setTimeout(resolve, budgetMs)
    }),
  ])
}

function getAuthActionErrorMessage(result: unknown): string | null {
  if (!result || typeof result !== 'object' || !('error' in result)) {
    return null
  }

  const error = (result as { error?: unknown }).error
  if (!error) {
    return null
  }

  if (typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim().length > 0) {
      return message
    }
  }

  return 'Sign out failed'
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Sign out timed out'))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  }
}

export async function signOutCurrentUser(
  timeoutMs = USER_SIGN_OUT_TIMEOUT_MS,
): Promise<void> {
  const result = await withTimeout(Promise.resolve(signOut()), timeoutMs)
  const errorMessage = getAuthActionErrorMessage(result)
  if (errorMessage) {
    throw new Error(errorMessage)
  }
}

/**
 * Sign-out cleanup that keeps this device's chats and settings. Conversations
 * are device-scoped, not account-scoped, so signing out must not destroy them
 * unless the person asks (see `clearClientState`). Drops only what belongs to
 * the server session and the in-flight UI: session-bound chat state, the
 * invite cookie, a pending prompt, and `eco-` sessionStorage keys.
 */
export function clearSessionClientState(): void {
  clearInviteCodeCookie()
  clearPendingChatPrompt()
  useChatStore.getState().clearSessionState()
  removeEcoSessionStorageKeys()
}

function removeEcoSessionStorageKeys(): void {
  if (typeof window === 'undefined') return
  const sessionKeysToRemove: string[] = []
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i)
    if (!key) continue
    if (key.startsWith('eco-') || key.startsWith('eco:')) {
      sessionKeysToRemove.push(key)
    }
  }
  for (const key of sessionKeysToRemove) {
    sessionStorage.removeItem(key)
  }
}

export type ClearClientStateOptions = {
  /**
   * Also delete downloaded model weights (Cache API: `eco-local-ai-*` and the
   * WebLLM scopes). Account deletion passes `true`. Default FALSE: signing out
   * of one account on your own machine must not throw away a 1-2 GB download
   * that is device-scoped, not account-scoped.
   */
  includeModelFiles?: boolean
}

/**
 * Clear ALL user-specific client state (stores, IndexedDB, localStorage, caches).
 * Called on account deletion, and on sign-out only when the person ticks
 * "also remove my chats and settings from this device".
 * Preserves device preferences (theme, sidebar collapsed, font size).
 *
 * With `includeModelFiles: true` the downloaded weights go too. The slot
 * bindings (`eco-local-ai-slot-*`) and the evidence ledger are already swept as
 * `eco-` localStorage keys, so the next boot sees no bound model and takes the
 * ordinary first-run path; the preserved `eco-selected-model` holds a slot
 * ALIAS ("auto" / "eco-fast"), never a model id, so it cannot point at bytes
 * that no longer exist.
 */
export async function clearClientState(
  options?: ClearClientStateOptions,
): Promise<void> {
  clearInviteCodeCookie()
  clearPendingChatPrompt()
  clearGuestLocalContext()
  getOnboardingStore()?.getState().resetOnboarding()
  useChatStore.getState().clearSessionState()
  // Clear Zustand stores
  useConversationStore.getState().clearAll()
  useChatStore.getState().clearMessages()
  deleteAllConversations()
  await closeConversationPersistenceDb()

  if (typeof window !== 'undefined') {
    removeEcoSessionStorageKeys()

    suppressNextConversationPersistenceHydration()
    suppressNextServiceWorkerRegistration()
  }

  // Delete IndexedDB databases — wrap in promises so callers can await completion.
  // Un-awaited deleteDatabase can block subsequent openDB calls on the same DB name.
  if (typeof indexedDB !== 'undefined') {
    const deleteDB = async (name: string) => {
      const attemptDelete = () =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name)
          req.onsuccess = () => resolve()
          req.onerror = () => resolve() // resolve even on error so we never hang
          req.onblocked = () => resolve()
        })

      await attemptDelete()

      if (typeof indexedDB.databases !== 'function') {
        return
      }

      try {
        const remaining = await indexedDB.databases()
        if (remaining.some((db) => db.name === name)) {
          await attemptDelete()
        }
      } catch {
        // Ignore database enumeration failures — deleteDatabase already ran.
      }
    }
    await Promise.all([deleteDB('eco-chat'), deleteDB('eco-settings')])
  }

  // Remove all eco-namespaced localStorage keys except device preferences
  if (typeof window !== 'undefined') {
    const keysToRemove: string[] = []
    for (const key of safeStorage.keys()) {
      if (
        (key.startsWith('eco-') || key.startsWith('eco:'))
        && !PRESERVED_KEYS.has(key)
      ) {
        keysToRemove.push(key)
      }
    }
    for (const key of keysToRemove) {
      safeStorage.remove(key)
    }
  }

  // Clear service worker caches
  if ('caches' in globalThis) {
    await requestServiceWorkerClientReset()

    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations()
        await Promise.all(registrations.map((registration) => registration.unregister()))
      } catch {
        // Ignore unregister failures — clearing caches below is still worthwhile.
      }
    }

    // Weights first: they are the slow, gigabyte-scale part of the sweep, so if
    // the caller's cleanup budget expires we still want them under way.
    if (options?.includeModelFiles) {
      await deleteModelWeightCaches()
    }

    const deleteEcoCaches = async () => {
      const names = await caches.keys().catch(() => [] as string[])
      await Promise.all(
        names
          .filter(isEcoCacheName)
          .map((name) => caches.delete(name).catch(() => false)),
      )
    }

    await deleteEcoCaches()
    await deleteEcoCaches()
  }
}
