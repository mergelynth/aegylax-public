/**
 * Once-per-session guard for permissionless transitions the client sends
 * without being asked (`cancelLobby` on an under-filled room, including
 * a leftover Global Defense draw).
 *
 * Module-level on purpose: a `useRef` resets on remount, so navigating
 * away and back — or StrictMode's double-mount — would open the wallet
 * a second time for work that was already sent.
 */
const attempted = new Set<string>()

/** True the first time this transition is claimed this session; false after. */
export function claimProtocolAutoAttempt(lobbyId: string, action: string): boolean {
  const key = `${lobbyId}:${action}`
  if (attempted.has(key)) return false
  attempted.add(key)
  return true
}

/** Exposed for tests: the guard has to outlive components, so it must be resettable. */
export function __resetProtocolAutoAttempt(): void {
  attempted.clear()
}
