import { appConfig } from '../../config/env'
import { describeChain } from '../../config/networks'
import styles from './NetworkBadge.module.css'

/**
 * Which network the connected wallet is on.
 *
 * The name comes from the resolved chain rather than from a list written
 * here, so a build pointed at a network this file has never heard of still
 * says what it is. The one label that is *not* a chain name — "Emulator" —
 * is gated on the app actually running the emulator: a wallet that simply
 * did not report its chain id is an unknown network, not a simulated one,
 * and labelling it "Emulator" in a production build was telling players
 * their real transactions were fake.
 */
export function NetworkBadge({ chainId }: { chainId: number | null }) {
  const isEmulator = appConfig.blockchainMode === 'emulator'
  const expected = appConfig.chainId

  const label = isEmulator ? 'Emulator' : describeChain(chainId)

  // "Supported" means "the chain this build talks to". A wallet parked on
  // some other network is the case worth flagging, because every write from
  // it will be rejected.
  const isOnExpectedChain = isEmulator || (chainId !== null && chainId === expected)

  return (
    <span className={styles.badge}>
      {/*
        ТЗ §7 — the network light activates separately from the panel that
        wipes in around it, with the same bloom the HUD glyphs take: these
        are all status lights coming on, and they should all come on the
        same way.

        It stays in the main sequence at 420ms. The protocol shield used to
        share this class and has since left to join the brand corner, which
        arrives seconds later — a wallet light held back that long would
        read as the panel failing to connect.
      */}
      <span className={[styles.dot, isOnExpectedChain ? styles.ok : '', 'boot-dot'].join(' ')} />
      {label}
    </span>
  )
}
