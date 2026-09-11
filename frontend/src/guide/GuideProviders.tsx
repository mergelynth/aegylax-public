import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AuthContext } from '../auth/AuthContext'
import type { AuthSession } from '../auth/types'
import { BlockchainClientContext } from '../app/providers/BlockchainClientProvider'
import { appConfig } from '../config/env'
import { buildGuideChain, DEMO_PLAYER, type GuideChain } from './demoChain'

/**
 * The sandbox the guided tour runs in.
 *
 * Two context overrides and nothing else. Everything the product renders
 * reaches its data through one of them — `useBlockchainClient` for the
 * chain, `useAuth` for who is playing — so replacing the pair underneath a
 * subtree is enough to make the *real* Home page, the *real* Create dialog
 * and the *real* operation screen render a demo. No component is forked, no
 * prop is faked, and nothing in `components/` knows the tour exists beyond
 * the `data-guide` attributes it points at.
 *
 * They are nested inside the app's own providers rather than replacing
 * them, which is what keeps the tour contained: leave `/guide` and the
 * outer providers are still the ones in force.
 */

/**
 * A signed-in player, permanently.
 *
 * The tour is about what the product does once you are in, and a sign-in
 * wall in front of that would be a tour of a login button. `simulated` is
 * the honest kind — there is no transport behind this wallet and no key,
 * which is exactly true of a wallet that only ever spends sandbox money.
 */
function demoSession(): AuthSession {
  return {
    provider: 'local',
    status: 'authenticated',
    isReady: true,
    isAuthenticated: true,
    user: { id: 'guide-demo-player', loginMethod: null, label: 'Demo player' },
    wallet: { address: DEMO_PLAYER, chainId: appConfig.chainId ?? null, kind: 'simulated' },
    loginMethods: [],
    error: null,
    login: async () => undefined,
    logout: async () => undefined,
  }
}

export interface GuideSandbox {
  chain: GuideChain | null
  /** Non-null when the sandbox could not be built — the tour says so rather than hanging. */
  error: string | null
}

export function GuideProviders({
  children,
  onReady,
}: {
  children: (sandbox: GuideSandbox) => ReactNode
  onReady?: (chain: GuideChain) => void
}) {
  const [sandbox, setSandbox] = useState<GuideSandbox>({ chain: null, error: null })
  const session = useMemo(demoSession, [])

  useEffect(() => {
    let live = true

    buildGuideChain()
      .then((chain) => {
        if (!live) {
          // Nobody is watching this chain any more; stop its clock rather
          // than leaving a second emulator mining behind a closed tab.
          chain.client.dispose()
          return
        }
        setSandbox({ chain, error: null })
        onReady?.(chain)
      })
      .catch((error: unknown) => {
        if (!live) return
        setSandbox({ chain: null, error: error instanceof Error ? error.message : String(error) })
      })

    return () => {
      live = false
    }
    // Built once. A tour that re-seeded its chain would renumber every room
    // mid-visit, and the steps address rooms by id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /*
   * The chain provider is only mounted once there is a chain. Handing the
   * product a null client for the first frames would have every hook on
   * every screen throw on mount, which is a worse answer to "still loading"
   * than not rendering the screen yet.
   */
  if (!sandbox.chain) {
    return <AuthContext.Provider value={session}>{children(sandbox)}</AuthContext.Provider>
  }

  return (
    <AuthContext.Provider value={session}>
      <BlockchainClientContext.Provider value={sandbox.chain.client}>
        {children(sandbox)}
      </BlockchainClientContext.Provider>
    </AuthContext.Provider>
  )
}
