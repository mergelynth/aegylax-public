import { useSyncExternalStore } from 'react'
import type { AuthSession } from './types'

/**
 * Where a hosted provider's session waits for the app to read it.
 *
 * This exists so the provider does not have to be an *ancestor* of the app.
 * Privy's SDK is 1.6MB — more than the rest of the client put together —
 * and as a wrapper around `<App/>` every byte of it sat on the critical
 * path: the browser had to fetch and evaluate the whole vendor bundle
 * before React could paint a heading. Loading it lazily in that shape is no
 * better, because the tree cannot change from "no provider" to "provider"
 * without React unmounting everything underneath and mounting it again —
 * the scene, the boot sequence and all — a few hundred milliseconds after
 * the page appeared.
 *
 * So the provider is mounted as a *sibling* instead, and the session it
 * produces reaches the app through this store. `AuthContext` stays exactly
 * where it always was, at the top of the tree, with a value that changes
 * when the SDK finally answers. Nothing above `auth/` can tell the
 * difference: `useAuth()` returns an initializing session first and a real
 * one when it arrives, which is the same pair of states it already had
 * while the SDK restored a session from storage.
 *
 * A module-level value rather than a context or a zustand store: it is
 * written by exactly one component and read by exactly one, it has to exist
 * before either of them mounts, and `useSyncExternalStore` is what React
 * gives you for precisely that.
 */

let current: AuthSession | null = null
const listeners = new Set<() => void>()

/** Called by an adapter whenever its session changes. */
export function publishAuthSession(session: AuthSession | null): void {
  if (current === session) return
  current = session
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function read(): AuthSession | null {
  return current
}

/** The published session, or `null` while the adapter is still loading. */
export function usePublishedAuthSession(): AuthSession | null {
  return useSyncExternalStore(subscribe, read, read)
}

/**
 * Test seam. The store outlives a render, so a suite that mounts an adapter
 * twice would otherwise read the first mount's session in the second test.
 */
export function resetAuthSession(): void {
  publishAuthSession(null)
}
