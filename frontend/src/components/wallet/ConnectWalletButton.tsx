import { useState } from 'react'
import { RollingLabel } from '../common/RollingLabel'
import { useWallet } from '../../hooks/useWallet'
import { WalletStatus } from './WalletStatus'
import styles from './WalletPill.module.css'

/**
 * Compact glass pill (spec §3) — visually secondary to the primary
 * "Create Defense" CTA. The connected state (`WalletStatus`) reuses the
 * same `.pill` shell so there is only ever one wallet control, never two.
 *
 * It says "Sign in", in every configuration.
 *
 * It used to derive the wording from the session's login methods and call
 * itself "Connect Wallet" whenever a wallet was the only one on offer —
 * which made the header's most important control relabel itself according
 * to an adapter's internals, and it did exactly that the moment a dev-only
 * adapter mounted. A player is signing in to the app; whether that ends in
 * a wallet prompt or an email code is the provider's screen to explain, not
 * this button's, and it is not something the button can promise before the
 * provider is even ready.
 *
 * The two states below the label are the other half of the fix. Sign-in is
 * the only action in the app with no `useTxRunner` behind it — `connect`
 * resolves once the flow has been *handed to* the provider — so a provider
 * that was still initializing, or that refused to open at all, left a
 * button that looked live, did nothing, and said nothing.
 */
export function ConnectWalletButton() {
  const { address, isConnected, chainId, label, walletKind, status, error, connect, disconnect } = useWallet()
  const [starting, setStarting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  if (isConnected && address) {
    return (
      <WalletStatus
        address={address}
        chainId={chainId}
        label={label}
        isManaged={walletKind === 'managed'}
        onDisconnect={disconnect}
      />
    )
  }

  const handleConnect = async () => {
    setStarting(true)
    setFailure(null)
    try {
      await connect()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  /*
   * A press the provider cannot act on is not offered.
   *
   * `initializing` is both halves of that: the SDK's own `login` does
   * nothing until it has restored its session, and it errors outright for
   * somebody who is already authenticated and simply waiting on the managed
   * wallet being minted for them. Either way the button was live-looking and
   * inert, which is indistinguishable from broken.
   */
  const settling = status === 'initializing'
  const busy = settling || starting
  const message = failure ?? error?.message ?? null

  return (
    <div className={styles.walletRoot}>
      {/*
        ТЗ §27 — the label rolls under the pointer and the pill takes a short
        press; both come from the shared motion system, so this control
        behaves like the CTA it is secondary to rather than inventing its own
        idiom. The roll is on the label rather than the button so a busy
        state ("Signing in…") rolls exactly the same way.
      */}
      <button
        type="button"
        className={`${styles.pill} motion-roll-host motion-press`}
        onClick={() => void handleConnect()}
        disabled={busy}
        aria-busy={busy}
      >
        <RollingLabel>{starting ? 'Signing in…' : settling ? 'Loading…' : 'Sign in'}</RollingLabel>
      </button>
      {message ? (
        <div className={styles.signInError} role="alert">
          <span className={styles.signInErrorMark} aria-hidden="true">
            !
          </span>
          <span>{message}</span>
        </div>
      ) : null}
    </div>
  )
}
