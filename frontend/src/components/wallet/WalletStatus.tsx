import { useEffect, useRef, useState } from 'react'
import { appConfig } from '../../config/env'
import { describeChain } from '../../config/networks'
import { isWalletEmpty, isWalletLow, useFaucet } from '../../hooks/useFaucet'
import { useWalletBalance } from '../../hooks/useWalletBalance'
import { getAddressUrl } from '../../utils/explorer'
import { formatCountdown, formatEth, shortenHex } from '../../utils/format'
import { NetworkBadge } from './NetworkBadge'
import { PlayerOperations } from './PlayerOperations'
import { PlayerRecordPanel } from './PlayerRecordPanel'
import styles from './WalletPill.module.css'

export interface WalletStatusProps {
  address: `0x${string}`
  chainId: number | null
  /**
   * The human name of whoever is signed in — an email or a social handle.
   * Null when the wallet is all there is to know about them.
   */
  label?: string | null
  /**
   * Whether the keys are held for this player by the sign-in provider.
   *
   * It changes what the panel has to explain rather than how it looks.
   * Somebody who connected their own wallet already has somewhere to top it
   * up and knows where; somebody who signed in with an email has a wallet
   * they never chose, whose address they have never seen, and no other app
   * to look it up in — so this screen is the only place the deposit address
   * can come from.
   */
  isManaged?: boolean
  onDisconnect: () => void
}

/**
 * Copy to clipboard, with the confirmation that makes it believable.
 *
 * A copy button that does nothing visible is indistinguishable from a copy
 * button that failed, and this one is copying the string a player is about
 * to send money to — the one place in the app where "did that work?" has an
 * expensive wrong answer. The flag clears itself so the control goes back to
 * being an invitation.
 */
function useCopy(): { copied: boolean; copy: (value: string) => void } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), [])

  const copy = (value: string) => {
    const done = () => {
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1800)
    }
    // `navigator.clipboard` is absent on insecure origins and in older
    // browsers; the textarea fallback is what keeps the address copyable
    // over plain HTTP on a LAN address, which is how this gets tested.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(done, () => fallbackCopy(value, done))
    } else {
      fallbackCopy(value, done)
    }
  }

  return { copied, copy }
}

/**
 * Milliseconds left until `targetMs`, ticking once a second, or null when
 * there is nothing to wait for.
 *
 * A clock rather than a phrase, because the thing it is attached to is a
 * control that cannot be pressed yet: "in 3 hours" is a fact about the day,
 * and a figure counting down is the button telling you it is coming back.
 *
 * It stops itself at zero. The panel it lives in is often left open on a
 * screen nobody is looking at, and there is no reason for a timer that has
 * finished to keep waking the tab once a second for ever.
 */
function useCountdownTo(targetMs: number | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(() =>
    targetMs === null ? null : Math.max(0, targetMs - Date.now()),
  )

  useEffect(() => {
    if (targetMs === null) {
      setRemaining(null)
      return
    }

    const tick = () => {
      const left = Math.max(0, targetMs - Date.now())
      setRemaining(left)
      if (left === 0) clearInterval(timer)
    }

    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [targetMs])

  return remaining
}

function fallbackCopy(value: string, done: () => void): void {
  const field = document.createElement('textarea')
  field.value = value
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.appendChild(field)
  field.select()
  try {
    document.execCommand('copy')
    done()
  } finally {
    document.body.removeChild(field)
  }
}

function DisconnectIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" className={styles.disconnectIcon}>
      <path d="M12 4v7" />
      <path d="M6.5 6.6a7.5 7.5 0 1 0 11 0" />
    </svg>
  )
}

/** A falling drop: the wallet is too empty to play, and there is a top-up for it. */
function DropIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 2.8c3.4 4.2 6 7.6 6 10.7a6 6 0 0 1-12 0c0-3.1 2.6-6.5 6-10.7Z" />
    </svg>
  )
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  )
}

/**
 * Connected state of the wallet pill — same bubble, now holding network,
 * identity, balance and the disconnect action together (spec §3: never a
 * second wallet control).
 *
 * A player who signed in with an email or a social account is named by it
 * rather than by twelve hex characters they never chose. The address it
 * replaces is not gone, though: pressing the pill opens the account panel,
 * where the address is on screen in full, copyable in one press, and stated
 * as the place to send funds to.
 *
 * That panel is the fix for a real dead end rather than a nicety. Sign in
 * with an email and the header shows the email, the balance shows 0, and
 * every action costs ETH — with the deposit address nowhere on screen there
 * was no way to fund the wallet at all without knowing to hover a tooltip
 * for the address it hid.
 */
export function WalletStatus({ address, chainId, label, isManaged = false, onDisconnect }: WalletStatusProps) {
  const balance = useWalletBalance(address)
  const [open, setOpen] = useState(false)
  const { copied, copy } = useCopy()
  const faucet = useFaucet(address)
  const container = useRef<HTMLDivElement>(null)
  /*
   * How long until this wallet may ask again — counted from whatever the
   * server last said, whether that was a drip landing or a refusal for
   * asking too soon. Null until one of those has happened: a wallet that
   * has not asked is not waiting, and the control is simply available.
   */
  const cooldownMs = useCountdownTo(faucet.retryAtMs)
  const waiting = cooldownMs !== null && cooldownMs > 0

  // A panel that outlives the click that dismissed it reads as stuck.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const isEmulator = appConfig.blockchainMode === 'emulator'
  /*
   * No faucet against the emulator: its balances are invented in this tab,
   * so a top-up would be a request to a server for money that is not real.
   * This is the only thing that takes the control off the screen — below,
   * the button is always on the panel and it is its *state* that changes.
   */
  const hasFaucet = !isEmulator
  /*
   * The drop in the header, and the offer in the panel, on two different
   * lines — see `isWalletEmpty`. Both answer false while the balance is
   * still loading, so neither fires on a page load before the first read
   * lands.
   */
  const isEmpty = hasFaucet && isWalletEmpty(balance)
  const needsTopUp = hasFaucet && isWalletLow(balance)
  /*
   * No explorer link against the emulator, even when the build has an
   * explorer URL configured for its target chain. An emulator address exists
   * only in this browser, so the link would open a real explorer's
   * "address not found" — which reads as the wallet being broken rather
   * than as the address being local.
   */
  const explorerUrl = isEmulator ? null : getAddressUrl(address)
  const networkName = isEmulator ? 'the emulator' : describeChain(chainId ?? appConfig.chainId)

  return (
    <div className={styles.walletRoot} ref={container}>
      {/*
        ТЗ §8 — hovering the panel brightens what it says without changing
        its size. `motion-reveal-host` is the trigger; the two readouts
        below carry `motion-reveal` and lift a single pixel into full-
        strength ink. Explicitly *not* a scale: ТЗ §8 rules out growing the
        panel, and a header control that resizes under the pointer pushes
        the whole bar around.
      */}
      <div className={[styles.pill, styles.connected, 'motion-reveal-host'].join(' ')}>
        <NetworkBadge chainId={chainId} />
        <button
          type="button"
          className={styles.identityButton}
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-haspopup="dialog"
          // Named for what it opens rather than by its own contents: the
          // contents are an email or a truncated address, neither of which
          // tells anybody that the deposit address is behind it.
          aria-label={isEmpty ? 'Wallet address, deposits and top-up' : 'Wallet address and deposits'}
          title={isEmpty ? 'Empty wallet — open for a top-up' : 'Wallet address and deposits'}
        >
          <span className={`${styles.address} motion-reveal`}>{label ?? shortenHex(address)}</span>
          {balance !== null ? (
            <>
              <span className={styles.divider} aria-hidden="true" />
              <span className={`${styles.balance} motion-reveal`}>{formatEth(balance, 3)}</span>
              {/*
                The drop is the whole of the prompt, and it appears only on
                a wallet holding nothing — the panel behind this button is
                where the top-up lives, so the icon's job is to make
                somebody press the thing they were going to walk past.
              */}
              {isEmpty ? (
                <span className={styles.dropSlot} aria-hidden="true">
                  <DropIcon className={styles.lowBalanceIcon} />
                </span>
              ) : null}
            </>
          ) : null}
        </button>
        <button type="button" className={styles.disconnectButton} onClick={onDisconnect} aria-label="Disconnect wallet">
          <DisconnectIcon />
        </button>
      </div>

      {open ? (
        <div className={styles.panel} role="dialog" aria-label="Wallet">
          {label ? <p className={styles.panelLabel}>{label}</p> : null}

          <p className={styles.panelHeading}>Your wallet address</p>
          {/*
            The whole address, not a shortened one. This is the string that
            gets pasted into an exchange withdrawal, and an elided middle is
            exactly the part somebody would have to guess at.
          */}
          <p className={styles.addressFull}>{address}</p>

          {/*
            The two things there are to do with this address, on one line:
            take it somewhere else, or have it funded from here. They were
            stacked with a paragraph between them, which read as two
            unrelated features rather than as the pair of answers to "how do
            I get ETH into this wallet".
          */}
          <div className={styles.panelActions}>
            <button type="button" className={styles.copyButton} onClick={() => copy(address)}>
              <CopyIcon className={styles.copyIcon} />
              {copied ? 'Copied' : 'Copy address'}
            </button>

            {/*
              Always on the panel wherever there is a faucet at all, and it
              is the *state* that answers rather than its presence.

              A control that comes and goes with the balance is the harder
              thing to use, not the tidier one. It vanished at the moment a
              drip landed — which reads as the press having broken it — and
              anybody wondering "can I get test ETH here" had to already be
              broke to find out that they could. A button that is on screen
              and disabled answers that question at rest.
            */}
            {hasFaucet ? (
              <button
                type="button"
                /*
                  The wave is tied to the header's drop, not to the button
                  being pressable. It is the loudest thing this panel does,
                  and a wallet that is merely short does not need shouting
                  at — it can still play. Empty cannot, and that is the one
                  state worth interrupting for. Same condition, two places:
                  the drip in the bar and the pulse down here are one signal.
                */
                className={[styles.faucetButton, isEmpty ? styles.faucetUrgent : '']
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => void faucet.request(address)}
                disabled={faucet.status === 'sending' || waiting || !needsTopUp}
                /*
                  The clock is the label, so the accessible name has to carry
                  what the clock means — "23:41:02" alone names nothing. The
                  funded case says why it is dark, which is the one state a
                  disabled button here would otherwise leave unexplained.
                */
                aria-label={
                  waiting ? `Top up again in ${formatCountdown(cooldownMs ?? 0)}` : undefined
                }
                title={
                  waiting
                    ? 'Already topped up — one per wallet per day'
                    : needsTopUp
                      ? 'Get test ETH'
                      : 'Your wallet has enough to play'
                }
              >
                <DropIcon className={styles.faucetIcon} />
                {faucet.status === 'sending' ? (
                  'Sending…'
                ) : waiting ? (
                  <span className={styles.faucetClock}>{formatCountdown(cooldownMs ?? 0)}</span>
                ) : (
                  'Get test ETH'
                )}
              </button>
            ) : null}
          </div>

          <p className={styles.panelNote}>
            {isManaged
              ? `This wallet was created for you when you signed in. Send ETH on ${networkName} to the address above to fund it — nothing else is needed.`
              : `Send ETH on ${networkName} to this address to fund it.`}
          </p>

          {/*
            A refusal that is not the cooldown — the faucet is empty, or
            unreachable. The cooldown needs no sentence: the button is
            wearing it.
          */}
          {faucet.status === 'failed' && !waiting ? (
            <p className={styles.faucetError}>{faucet.error}</p>
          ) : null}

          {/*
            Below the funding, above the explorer link: what the wallet is
            comes first for somebody who cannot play yet, and what it has done
            comes first for everybody else. The section is absent only when
            the deployment keeps no records.
          */}
          <PlayerRecordPanel address={address} />

          {/*
            And the way back into whatever this wallet is still in. It closes
            the panel on its way out: a dropdown that outlives the navigation
            that left it sits over the page somebody just asked for.
          */}
          <PlayerOperations address={address} onNavigate={() => setOpen(false)} />

          {explorerUrl ? (
            <a className={styles.panelLink} href={explorerUrl} target="_blank" rel="noreferrer noopener">
              View on explorer
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
