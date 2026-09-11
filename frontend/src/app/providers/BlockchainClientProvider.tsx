import { createContext, useEffect, useMemo, type ReactNode } from 'react'
import { createBlockchainClient, type BlockchainClient } from '../../blockchain'
import { appConfig } from '../../config/env'

export const BlockchainClientContext = createContext<BlockchainClient | null>(null)

interface Disposable {
  dispose: () => void
}

interface Startable {
  start: () => void
}

function isDisposable(client: BlockchainClient): client is BlockchainClient & Disposable {
  return typeof (client as Partial<Disposable>).dispose === 'function'
}

function isStartable(client: BlockchainClient): client is BlockchainClient & Startable {
  return typeof (client as Partial<Startable>).start === 'function'
}

/**
 * Creates the single `BlockchainClient` instance for the app's lifetime.
 * Which implementation gets created is entirely decided by
 * `VITE_BLOCKCHAIN_MODE` inside `createBlockchainClient` — this component
 * never references the emulator or contract client by name.
 */
export function BlockchainClientProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => createBlockchainClient(appConfig), [])

  /*
   * Setup must mirror teardown. StrictMode deliberately runs this effect's
   * cleanup and then sets it up again on the same client, so a teardown
   * that stops the clock needs a setup that starts it — otherwise the
   * first StrictMode remount leaves the chain stopped for the session.
   */
  useEffect(() => {
    if (isStartable(client)) client.start()

    return () => {
      if (isDisposable(client)) client.dispose()
    }
  }, [client])

  return <BlockchainClientContext.Provider value={client}>{children}</BlockchainClientContext.Provider>
}
