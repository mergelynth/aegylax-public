import type { Address, AttackRevealData, Participant } from '../../game/types'
import { isAlreadyDown, isTooLate, isTooEarly } from '../../game/defense'
import { sameAddress } from '../../utils/address'
import styles from './ResultHud.module.css'

export interface ResultHudProps {
  reveal: AttackRevealData
  participants: Participant[]
  viewer: Address | null
}

/**
 * The Result HUD (ТЗ §10) — the round's whole summary in one short row,
 * directly under TARGET REACHED / TARGET INTERCEPTED.
 *
 * It exists because the verdict alone answers one question and leaves
 * three: whether *this* player was one of the defenders who stopped it, how
 * many of them there were, and how much play there was in the round. So it
 * is four figures and no more — pills rather than cards, deliberately,
 * because it sits under the largest type on the screen and must not compete
 * with it, and readable at a glance rather than squinted at, because it is
 * the last thing the operation says.
 *
 * WINNERS is the payout set: the earliest snapshot hit, plus every hit that
 * shares its block. DEFENDERS is the field they were up against. PROBES is
 * what the round cost in reconnaissance, across everybody.
 *
 * Every number here is read off revealed state. Before the reveal none of
 * it is knowable — not the interception count, not the probe totals, not
 * even how many actions somebody else took broken down by kind (ТЗ §4) —
 * which is exactly why the HUD appears with the reveal and not with the
 * impact.
 */
export function ResultHud({ reveal, participants, viewer }: ResultHudProps) {
  const ownResult = viewer ? reveal.results.find((result) => sameAddress(result.participant, viewer)) : undefined
  const winners = reveal.outcome.winners.length
  const hit = ownResult?.isWinner === true
  const outranked = ownResult ? isAlreadyDown(ownResult) : false
  const late = ownResult ? isTooLate(ownResult) : false
  const early = ownResult ? isTooEarly(ownResult) : false
  // Being beaten to the kill is its own outcome. The shot was on the threat
  // at the right moment; someone else's interceptor simply arrived first, and
  // flattening that into MISSED would tell this defender to fix an aim that
  // was never wrong.
  const ownValue = !ownResult
    ? 'NO DEFENSE'
    : hit
      ? 'YOU HIT'
      : outranked
        ? 'ALREADY DOWN'
        : late
          ? 'TOO LATE'
          : early
            ? 'TOO EARLY'
            : 'YOU MISSED'
  const ownTone = !ownResult ? 'none' : hit ? 'hit' : outranked || late || early ? 'late' : 'miss'

  return (
    <div className={styles.hud} aria-label="Result summary">
      {/*
        ТЗ §10 — the player's own line first. Five states rather than two:
        a defender who never submitted did not miss, they did not play;
        an outranked hit is ALREADY DOWN, not YOU MISSED.
      */}
      <Pill
        label="My status"
        value={ownValue}
        tone={ownTone}
      />
      <Pill label="Winners" value={String(winners)} tone={winners > 0 ? 'winner' : 'plain'} />
      <Pill label="Defenders" value={String(participants.length)} tone="plain" />
      <Pill label="Probes" value={String(sumBy(participants, (p) => p.probeIds.length))} tone="plain" />
    </div>
  )
}

function Pill({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <span className={[styles.pill, styles[tone] ?? ''].filter(Boolean).join(' ')}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
    </span>
  )
}

function sumBy<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0)
}
