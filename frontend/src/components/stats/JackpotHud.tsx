import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { appConfig } from '../../config/env'
import { useEpochClock } from '../../hooks/useEpochClock'
import { useGlobalDefenseDraw } from '../../hooks/useGlobalDefenseDraw'
import { useGlobalDefenseKeeper } from '../../hooks/useGlobalDefenseKeeper'
import { useSmoothCountdown } from '../../hooks/useSmoothCountdown'
import { useBootEntrance } from '../../motion/useBootEntrance'
import { formatBlockNumber, formatGameFigure, formatLongCountdown } from '../../utils/format'
import styles from './JackpotHud.module.css'
import { TrophyIcon } from './StatusIcons'

const ALERT_MS = 620

/**
 * The Global Defense jackpot, parked next to the protocol-status shield.
 *
 * Amount + ticker come from `appConfig.currency`. The trophy is a link
 * only inside the join window — never a button that sends a transaction.
 * Hover or tap names the next beat: **Opens in** while the prize accumulates,
 * **Open now** only while people can still join. Hidden when the jackpot
 * is empty — a 0 trophy is not a status, it is noise.
 */
export function JackpotHud() {
  /*
   * ТЗ §32 — the pill belongs to the shield's beat, not to its own.
   *
   * Asked here rather than read from the DOM so the answer is pinned to
   * this mount: the entrance is a 2960ms wait, and the boot window closes
   * at 2100ms, underneath it. `ProtocolStatus` asks the same question at
   * the same moment, which is what makes the pair land together — see "the
   * brand signs itself" in `app/motion.css`.
   */
  const entering = useBootEntrance()
  const draw = useGlobalDefenseDraw()
  useGlobalDefenseKeeper(draw)
  const { ticker, name } = appConfig.currency
  const { blockNumber, timestampMs } = useEpochClock()
  const blockTimeMs = appConfig.blockTimeMs
  const amount = draw.jackpot
  const previous = useRef<number | string>(amount)
  const primed = useRef(false)
  const [alerting, setAlerting] = useState(false)
  const [pinned, setPinned] = useState(false)

  useEffect(() => {
    if (!draw.ready) return
    const before = previous.current
    previous.current = amount
    if (!primed.current) {
      primed.current = true
      return
    }
    if (before === amount) return
    if (typeof before !== 'number') return

    setAlerting(true)
    const timeout = setTimeout(() => setAlerting(false), ALERT_MS)
    return () => clearTimeout(timeout)
  }, [amount, draw.ready])

  const targetBlock = draw.joinable ? draw.deadlineBlock : draw.openFromBlock
  const blocksRemaining =
    targetBlock !== null && blockNumber !== null ? Math.max(0, targetBlock - blockNumber) : null
  const msRemaining = useSmoothCountdown(blocksRemaining, blockTimeMs, timestampMs)

  const figure = formatGameFigure(amount, 3)
  const shown = `${figure} ${ticker}`
  const { label, description } = tooltipCopy({
    amount,
    name,
    draw,
    blocksRemaining,
    msRemaining,
  })

  if (draw.ready && amount <= 0) return null

  const classes = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(' ')
  const shell = classes(styles.jackpot, entering && 'sign-jackpot', pinned && styles.pinned)
  const inner = (
    <>
      <TrophyIcon className={classes(styles.icon, alerting && styles.alerting)} aria-hidden="true" />
      <span className={classes(styles.value, alerting && styles.flash)}>
        {draw.ready ? (
          <>
            <span className={styles.figure}>{figure}</span>
            <span className={styles.ticker}>{ticker}</span>
          </>
        ) : (
          <span className={styles.skeleton} aria-hidden="true" />
        )}
      </span>
      <span className={styles.tooltip} role="tooltip">
        <span className={styles.tooltipLabel}>{draw.ready ? label : 'Jackpot'}</span>
        <span className={styles.tooltipDescription}>
          {draw.ready ? description : `Loading the Global Defense pool (${name}).`}
        </span>
      </span>
    </>
  )

  if (draw.ready && draw.joinable && draw.lobbyId) {
    return (
      <Link
        to={`/lobby/${draw.lobbyId}`}
        viewTransition
        className={shell}
        data-guide="jackpot"
        aria-label={`Jackpot: ${shown}. Join the Global Defense lobby.`}
      >
        {inner}
      </Link>
    )
  }

  return (
    <span
      className={shell}
      data-guide="jackpot"
      tabIndex={0}
      aria-busy={!draw.ready}
      aria-expanded={pinned}
      aria-label={draw.ready ? `Jackpot: ${shown}` : 'Jackpot loading'}
      onClick={() => setPinned((open) => !open)}
      onBlur={() => setPinned(false)}
    >
      {inner}
    </span>
  )
}

function tooltipCopy(input: {
  amount: number
  name: string
  draw: ReturnType<typeof useGlobalDefenseDraw>
  blocksRemaining: number | null
  msRemaining: number | null
}): { label: string; description: string } {
  const { amount, name, draw, blocksRemaining, msRemaining } = input
  const clock =
    blocksRemaining === null || msRemaining === null
      ? null
      : `${formatLongCountdown(msRemaining)} · ${blocksRemaining.toLocaleString()} blocks`
  const epoch = draw.nextEpoch > 0 ? `epoch ${draw.nextEpoch}` : null
  const atBlock =
    draw.openFromBlock !== null ? `opens at block ${formatBlockNumber(draw.openFromBlock)}` : null

  if (draw.joinable) {
    return {
      label: 'Open now',
      description: clock
        ? `Tap to join (${name}). Join until ${clock}.`
        : `Tap to join the Global Defense draw (${name}).`,
    }
  }

  if (draw.inPlay) {
    return {
      label: 'In play',
      description: epoch ? `Global Defense is running at ${epoch}` : 'Global Defense is running',
    }
  }

  if (clock) {
    const where = [epoch, atBlock].filter(Boolean).join(' · ')
    return {
      label: 'Opens in',
      description: `${clock}${where ? ` · ${where}` : ''}`,
    }
  }

  return {
    label: 'Jackpot',
    description:
      amount > 0
        ? `Waiting for the next Global Defense draw`
        : `Unwon pools, waiting for the next Global Defense draw (${name})`,
  }
}
