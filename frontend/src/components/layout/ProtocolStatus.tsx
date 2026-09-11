import type { ReactNode } from 'react'
import { SOCIAL_X_URL, SOURCE_REPOSITORY_URL } from '../../config/gameConfig'
import { useProtocolStatus, type ProtocolStatusLevel } from '../../hooks/useProtocolStatus'
import { useBootEntrance } from '../../motion/useBootEntrance'
import { formatBlockNumber, formatEth, shortenHex } from '../../utils/format'
import { ExplorerLink } from '../common/ExplorerLink'
import { ProtocolShieldIcon } from '../stats/StatusIcons'
import styles from './ProtocolStatus.module.css'

const LEVEL_LABEL: Record<ProtocolStatusLevel, string> = {
  operational: 'Defense',
  degraded: 'Degraded',
  offline: 'Offline',
}

/** All-span markup (the CSS supplies the flex layout) so the panel can live inside the inline trigger without invalid nesting. */
function DetailRow({
  label,
  value,
  hint,
  warn,
}: {
  label: string
  value: ReactNode
  hint?: string | null
  warn?: boolean
}) {
  return (
    <span className={[styles.row, warn ? styles.rowWarn : ''].filter(Boolean).join(' ')}>
      <span className={styles.rowMain}>
        <span className={styles.rowLabel}>{label}</span>
        <span className={styles.rowValue}>{value}</span>
      </span>
      {warn && hint ? <span className={styles.rowHint}>{hint}</span> : null}
    </span>
  )
}

function BlockValue({ block }: { block: number | null }) {
  if (block === null) return formatBlockNumber(block)
  return (
    <ExplorerLink kind="block" value={block}>
      {formatBlockNumber(block)}
    </ExplorerLink>
  )
}

/**
 * Restrained shield indicator next to the brand (spec §2, §8) — the ring
 * around it carries the state color, and the technical detail panel opens
 * on hover/focus only. Deliberately the exact same interaction model as
 * the Global Defense Status icons: no click-to-pin, so the panel never
 * outlives the pointer. Health comes from `useProtocolStatus`: chain
 * subscriptions, a light RPC heartbeat, and a covalidator readiness ping
 * on every page (plus gameplay reports when the layer stalls mid-probe).
 * Yellow is this tab seeing a delay, not a global vote.
 */
export function ProtocolStatus() {
  const status = useProtocolStatus()
  const entering = useBootEntrance()
  const label = LEVEL_LABEL[status.level]
  const { limits } = status

  return (
    <span
      /*
        The whole control fades in, not just the glyph inside it.

        The status light *is* the ring on this element — a border plus a
        travelling highlight painted by `::before`, with no separate dot —
        so fading only the shield underneath left a lit amber ring sitting
        in the header for the two seconds the corner is meant to be empty.
        See "the brand signs itself" in `app/motion.css`.
      */
      className={[styles.trigger, styles[status.level], entering ? 'sign-shield' : '']
        .filter(Boolean)
        .join(' ')}
      tabIndex={0}
      aria-label={`Protocol status: ${label}`}
    >
      {/* `motion-icon` is the restrained hover, live for the whole life of
          the page — the entrance is on the element above. */}
      <ProtocolShieldIcon className={`${styles.icon} motion-icon`} aria-hidden="true" />

      <span className={styles.popover} role="tooltip">
        <span className={styles.popoverHeader}>
          <span className={[styles.headerDot, styles[status.level]].join(' ')} aria-hidden="true" />
          <span className={styles.headerLabel}>{label}</span>
        </span>
        {/*
          Everything below the header scrolls, and the scroll container is
          here rather than on the panel itself — the panel owns the arrow and
          the invisible hover bridge, both of which sit *above* its box and
          are clipped away by any overflow context on it. See the stylesheet.
        */}
        <span className={styles.popoverBody}>
          <DetailRow label="Network" value={status.network} />
          {/*
            Chain head sits with the network it belongs to. RPC delay yellows
            this row rather than a separate "RPC connection" line — the block
            number is what stalled.
          */}
          <DetailRow
            label="Current block"
            warn={Boolean(status.rpcDelayReason)}
            hint={status.rpcDelayReason}
            value={<BlockValue block={status.currentBlock} />}
          />
          {/* The two values a player might want to verify elsewhere are the
            two that link out (ТЗ §12). */}
          <DetailRow
            label="Contract address"
            value={
              status.contractAddress ? (
                <ExplorerLink kind="address" value={status.contractAddress}>
                  {shortenHex(status.contractAddress, 6)}
                </ExplorerLink>
              ) : (
                '—'
              )
            }
          />

          {/*
          ТЗ §1, §3 — who provides confidentiality, and where.
          The name links to whoever provides it — from ENV, so a build wired
          to a different network links to that one — and the address is
          *their* own contract, taken from the deployment manifest. The row
          that used to sit here published this protocol's adapter instead,
          which named the right layer with the wrong contract: a player
          following it to check who can decrypt an attack landed on a
          contract we wrote.
        */}
          <span className={styles.group}>
            <DetailRow
              label="Privacy layer"
              warn={Boolean(status.privacyDelayReason)}
              hint={status.privacyDelayReason}
              value={
                status.privacyLayer === null ? (
                  '—'
                ) : status.privacyLayerUrl ? (
                  <a
                    href={status.privacyLayerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {status.privacyLayer}
                  </a>
                ) : (
                  status.privacyLayer
                )
              }
            />
            <DetailRow
              label="Privacy executor"
              value={
                status.privacyExecutorAddress ? (
                  <ExplorerLink kind="address" value={status.privacyExecutorAddress}>
                    {shortenHex(status.privacyExecutorAddress, 6)}
                  </ExplorerLink>
                ) : (
                  '—'
                )
              }
            />
            {/*
              The height the executor has ingested, same shape as the chain
              Current block above. Equal to the network head when nothing is
              behind; yellow only when the network itself said it is far behind.
              Indexer lag lives on this row alone — the protocol name above
              is not a second copy of the same sentence.
            */}
            <DetailRow
              label="Current block"
              warn={status.privacyExecutorBlockWarn}
              hint={status.privacyExecutorBlockHint}
              value={<BlockValue block={status.privacyExecutorBlock} />}
            />
          </span>

          {/*
            ТЗ §17 — the rules, from the same config the contract was deployed
            with. World geometry is protocol-owned but is not a *term*: a
            player never converts "0.14 sectors" into a decision, because the
            radius is drawn around their Defense Point on the board.
          */}
          <span className={styles.group}>
            <span className={styles.groupTitle}>Protocol & recon</span>
            {/* Charged once, at mint — never refunded, even if the room never fills. */}
            <DetailRow label="Creation fee" value={formatEth(status.protocolJoinFee)} />
            <DetailRow
              label="Recon probes"
              value={`${limits.freeReconProbes} free · ${formatEth(limits.reconProbePrice)} after`}
            />
            <DetailRow label="Probe limit" value={`${limits.maxReconProbes} max`} />
            <DetailRow label="Attack window" value={`${limits.epochBlocks} blocks`} />
          </span>

          {/*
            The walls a creator's own numbers have to fit between. Separated
            from the block above because nobody can change anything up there,
            and everything down here is a range somebody chooses inside of.
          */}
          <span className={styles.group}>
            <span className={styles.groupTitle}>Lobby limits</span>
            <DetailRow
              label="Players"
              value={`${limits.minPlayers.toLocaleString('en-US')} – ${limits.maxPlayers.toLocaleString('en-US')}`}
            />
            <DetailRow
              label="Entry price"
              value={`${formatEth(limits.minEntryPrice)} – ${formatEth(limits.maxEntryPrice)}`}
            />
            <DetailRow label="Minimum prize pool" value={formatEth(limits.minStartPrizePool)} />
            <DetailRow label="Creator fee" value={`up to ${limits.maxCreatorFeePercent}%`} />
            <DetailRow label="Join window" value={formatRegistrationWindow(limits)} />
          </span>
        </span>

        <span className={styles.footer}>
          {/*
            Two versions, because they answer different questions and were
            being read as one.

            `Contract version` is `AegylaxGame.version()` — a constant in the
            bytecode, so it names the implementation rather than the
            instance: the same source on a new proxy reports the same
            number, and only an upgrade moves it. That is the one that
            belongs beside the address above.

            `Site build` is this client — major 0 while it is testnet, patch
            ticking on every push that Vercel builds. It used to carry the
            label "Protocol version" on its own, which put a number that
            changes on a CSS fix next to a contract address and invited
            everybody to read it as the protocol's.

            Emulator mode has no contract, so that row is simply absent
            rather than showing a dash for something that does not exist.
          */}
          {status.contractVersion ? (
            <DetailRow label="Contract version" value={`v${status.contractVersion}`} />
          ) : null}
          <DetailRow label="Site build" value={`v${status.buildVersion}`} />
          {/*
            The standing disclosure, and the only place it is made.

            It is a line in the panel rather than a banner across the page
            because a banner is read once and then stops being read, while
            this sits with the network and the contract address it is about —
            next to the things somebody checking would already be looking at.
            The testnet half follows the chain the wallet actually signs
            against; the audit half is true on any network today.
          */}
          <span className={styles.disclosure}>
            {status.isTestnet
              ? 'Testnet build — the ETH here has no value, and the contracts have not been audited.'
              : 'The contracts have not been audited.'}
          </span>
          {/*
            One row, because both links answer the same question — where this
            came from — and stacking them would read as two separate offers.

            Both are handles rather than descriptions. "View source on GitHub"
            named the destination twice, once in the mark and once in the
            words; the handle instead says *whose* it is, which is the part
            the mark cannot carry. X sits first because the account is the
            way in for somebody reading the panel, and the repository is
            where that leads.

            `aria-label` on each contains its own visible text, so the
            accessible name still matches what is on screen while adding the
            service the mark shows and a screen reader cannot.
          */}
          <span className={styles.links}>
            <a
              className={styles.repoLink}
              href={SOCIAL_X_URL}
              target="_blank"
              // `noopener` is what stops the opened tab from reaching back
              // through `window.opener`; `noreferrer` follows it here because
              // nothing about this link needs a referrer to work.
              rel="noopener noreferrer"
              aria-label="@aegylax on X"
            >
              <XIcon className={styles.repoIcon} aria-hidden="true" />
              <span>aegylax</span>
            </a>
            <a
              className={styles.repoLink}
              href={SOURCE_REPOSITORY_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="@mergelynth on GitHub"
            >
              <GithubIcon className={styles.repoIcon} aria-hidden="true" />
              <span>mergelynth</span>
            </a>
          </span>
        </span>
      </span>
    </span>
  )
}

/**
 * The application window, in whatever unit reads as a duration rather than
 * as a number of milliseconds.
 *
 * A minimum of 0 is the documented normal case — "no floor" — and printing it
 * as "0m" invites the reading that an operation must close instantly.
 */
function formatRegistrationWindow(limits: {
  minRegistrationDurationMs: number
  maxRegistrationDurationMs: number
}): string {
  const oneDayMs = 24 * 60 * 60 * 1000
  const days = (ms: number) => `${Math.round((ms / oneDayMs) * 10) / 10}d`
  const minutes = (ms: number) => `${Math.round(ms / 60_000)}m`

  const max =
    limits.maxRegistrationDurationMs >= oneDayMs
      ? days(limits.maxRegistrationDurationMs)
      : minutes(limits.maxRegistrationDurationMs)
  if (limits.minRegistrationDurationMs <= 0) return `up to ${max}`

  const min =
    limits.minRegistrationDurationMs >= oneDayMs
      ? days(limits.minRegistrationDurationMs)
      : minutes(limits.minRegistrationDurationMs)
  return `${min} – ${max}`
}

/** X's mark, filled like `GithubIcon` rather than stroked. */
function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true" focusable="false">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

/** GitHub's mark, drawn as a filled path rather than the stroked `IconBase` family. */
function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true" focusable="false">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}
