import { appConfig } from '../../config/env'
import {
  APOCALYPSE_BASE_TIMESTAMP,
  APOCALYPSE_DAYS_PER_INTERCEPT,
  APOCALYPSE_DAYS_PER_MISS,
} from '../../config/gameConfig'
import { ATTACK_BIAS_DEGREES, BASE_CONE_DEGREES, MIN_CONE_DEGREES, PROBE_DELAY_BLOCKS } from '../../game/recon'
import { formatGameAmount } from '../../utils/format'
import styles from './HowToPlay.module.css'

function money(amount: number): string {
  return formatGameAmount(amount, appConfig.currency.ticker)
}

function approxDuration(ms: number): string {
  if (ms < 90_000) return `~${Math.max(1, Math.round(ms / 1000))}s`
  if (ms < 90 * 60_000) return `~${Math.max(1, Math.round(ms / 60_000))} min`
  if (ms < 36 * 3_600_000) {
    const hours = ms / 3_600_000
    return `~${hours >= 10 ? Math.round(hours) : Number(hours.toFixed(1))} h`
  }
  const days = ms / 86_400_000
  return `~${days >= 10 ? Math.round(days) : Number(days.toFixed(1))} days`
}

function formatUtcDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * Everything the onboarding deliberately leaves out — economics, creator
 * parameters, the jackpot, Day X, and the live protocol constants.
 *
 * Collapsed by default and last on the page, because a player who has not
 * run a single operation cannot use any of it, and printing it above the
 * fold is what made the old page unreadable.
 *
 * The wording here is plainer than it was — short sentences, ordinary words,
 * and the protocol's own terms introduced rather than assumed. It is still
 * the reference: every rule, number and edge case the four steps above skip
 * is written down somewhere in this block, and nothing has been dropped to
 * make it read more easily. This is where "probe", "epoch" and "Defense
 * Point" are allowed to be used, because a reader who has opened it has
 * already met them on the screen.
 */
export interface AdvancedRulesProps {
  open: boolean
  onToggle: (open: boolean) => void
}

export function AdvancedRules({ open, onToggle }: AdvancedRulesProps) {
  const { protocol, map, blockTimeMs, currency } = appConfig
  const ticker = currency.ticker
  const epochMs = protocol.epochBlocks * blockTimeMs
  const jackpotMs = protocol.globalDefenseEpochInterval * epochMs
  const joinWindow = approxDuration(protocol.globalDefenseJoinWindowMs)

  return (
    <details
      id="advanced"
      className={styles.advanced}
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary className={styles.advancedSummary}>
        <span>Advanced rules</span>
        <span className={styles.advancedMark} aria-hidden="true" />
      </summary>

      <div className={styles.advancedBody}>
        <section className={styles.topic}>
          <h3>A round</h3>
          <ol className={styles.steps}>
            <li>
              <strong>Create.</strong> Someone opens a room and puts the prize money into it in {ticker}.
            </li>
            <li>
              <strong>Join.</strong> You pay the entry and the room owner&apos;s fee. You can leave until the
              doors close.
            </li>
            <li>
              <strong>Launch.</strong> Once the doors close, the hidden attack flies. It flies for exactly one
              epoch — the protocol&apos;s own unit of time, counted in blocks.
            </li>
            <li>
              <strong>Recon.</strong> Probes are the clues. Each one hints at the direction the attack came
              from.
            </li>
            <li>
              <strong>Defend.</strong> One Defense Point — a place <em>and</em> a moment. The moment is the
              block your transaction lands in.
            </li>
            <li>
              <strong>Impact.</strong> Every point sitting on the attack <em>at that moment</em> hits, and they
              share the prize.
            </li>
            <li>
              <strong>Claim.</strong> Winners take their share. The room owner takes their fee.
            </li>
          </ol>
        </section>

        <section className={styles.topic}>
          <h3>Aiming</h3>
          <p>
            A high point meets the attack early in its flight, so you have to send it just as the attack gets
            there. A low point is a later pass: easier to aim at, and easy to send too soon and miss.
          </p>
          <p>More probes sharpen the picture, but a little of the hiding always stays.</p>
        </section>

        <section className={styles.topic}>
          <h3>What the creator chooses</h3>
          <div className={styles.split}>
            <div>
              <h4>Creator chooses</h4>
              <ul>
                <li>Room name</li>
                <li>Number of players</li>
                <li>Entry price</li>
                <li>Prize pool</li>
                <li>Application deadline</li>
                <li>Creator fee</li>
              </ul>
            </div>
            <div>
              <h4>What cannot be changed</h4>
              <ul>
                <li>Protocol creation fee</li>
                <li>Epoch length</li>
                <li>Probe rules and delay</li>
                <li>Attack uncertainty</li>
                <li>Defense radius</li>
                <li>Winner calculation</li>
                <li>Jackpot rules</li>
              </ul>
            </div>
          </div>
        </section>

        <section className={styles.topic}>
          <h3>Money</h3>
          <p>
            <strong>The room owner pays</strong> the prize money plus the protocol&apos;s opening fee. The
            protocol keeps that fee even if the room never fills up.
          </p>
          <p>
            <strong>A player pays</strong> the entry plus the owner&apos;s fee, and any extra probes on top.
            All of the entry goes into the prize. The opening fee and the owner&apos;s fee never do.
          </p>
          <ul className={styles.outcomes}>
            <li>
              <strong>🏆 Someone stops it.</strong> The winners share the prize. The room owner takes their fee
              even if they missed.
            </li>
            <li>
              <strong>❌ Nobody stops it.</strong> The prize moves to Global Defense. Entries are not refunded.
            </li>
            <li>
              <strong>🚫 Not enough players.</strong> Joiners are paid back automatically — entry, fee, probes.
              The owner gets the prize money back; the protocol keeps the opening fee.
            </li>
          </ul>
        </section>

        <section className={styles.topic}>
          <h3>Recon in detail</h3>
          <p>
            A probe never says where the attack is. It says which way it came in and roughly where it is going —
            a corridor to search, never a point to sit on.
          </p>
          <p>
            {protocol.freeReconProbes} probes are free and {protocol.maxReconProbes} is the most you can have.
            The rest are bought before the attack launches. After it launches you play with what you prepared.
          </p>
          <p>
            The first probe sweeps a wide piece of sky ({BASE_CONE_DEGREES}°). Each one after it narrows the
            picture you already have. One press sends one probe, and every probe takes a while to answer.
          </p>
          <p>
            Every probe in a round is wrong in the same small way, on purpose. Buying more of them clears the
            random noise, and never that shared error.
          </p>
          <p>
            The blue cloud is the corridor the readings still allow. It has no hard edge on purpose — the attack
            can be just outside the part you can see. From the second probe on, each reading also drops a red
            mark where <em>that</em> probe thinks the attack is. The pile of marks is evidence, not a target.
          </p>
          <p>
            When the round is revealed the clues come off the map, and what is left is the real path and the
            Defense Points it was judged against.
          </p>
        </section>

        <section className={styles.topic}>
          <h3>Defense in detail</h3>
          <p>
            You choose one Defense Point, and the protocol looks once: at the block your transaction lands in.
          </p>
          <p>
            At that moment the attack must still be flying and must be inside your radius. Send it before the
            attack has come down that far and you get TOO EARLY. Send it after the attack has gone past and you
            get TOO LATE. Miss it sideways and you get YOU MISSED.
          </p>
          <p>
            Everyone whose shot was on the attack shares the prize. Being first does not beat someone who hit it
            later, further down the path.
          </p>
        </section>

        <section className={styles.topic}>
          <h3>Global Defense Jackpot</h3>
          <p>
            When nobody stops an attack, that prize is not given back to the room owner. It goes into one shared
            Global Defense pool, and every {protocol.globalDefenseEpochInterval} epochs the protocol opens a free
            room to play for it.
          </p>
          <ul>
            <li>No entry price and no owner&apos;s fee.</li>
            <li>Nobody owns the room — the protocol opens it.</li>
            <li>The whole Global Defense pool is the prize.</li>
            <li>
              Up to {protocol.maxPlayers} defenders — the protocol ceiling, frozen when the room is minted.
            </li>
          </ul>
          <p>If nobody stops that one either, the prize waits for the next jackpot round.</p>
        </section>

        <section className={styles.topic}>
          <h3>Time</h3>
          <p>
            The contract counts in blocks, not in minutes. Every countdown you see on screen is a guess made
            from them.
          </p>
          <p>
            A player&apos;s room starts once its doors close, unless too little of the epoch would be left for a
            full flight — then it waits one more epoch. The protocol&apos;s own jackpot room is the exception: it
            closes at the end of one epoch and flies at the start of the next.
          </p>
        </section>

        <section className={styles.topic}>
          <h3>Day X</h3>
          <p>
            Day X is the clock over Earth, and it starts at {formatUtcDate(APOCALYPSE_BASE_TIMESTAMP)}. Every
            attack nobody stops pulls it {APOCALYPSE_DAYS_PER_MISS} days closer. Every attack somebody stops
            pushes it {APOCALYPSE_DAYS_PER_INTERCEPT} days away.
          </p>
        </section>

        <section className={styles.topic}>
          <h3>Technical details</h3>
          <p>
            The numbers this build is actually running on. Changing any of them means deploying a new protocol —
            no room owner can touch them.
          </p>
          <ul>
            <li>
              Protocol creation fee {money(protocol.joinFee)} — the only thing the owner may withdraw. Players{' '}
              {protocol.minPlayers}–{protocol.maxPlayers}. Entry {money(protocol.minEntryPrice)}–
              {money(protocol.maxEntryPrice)}. Min pool {money(protocol.minStartPrizePool)}. Creator commission
              up to {protocol.maxCreatorFeePercent}%.
            </li>
            <li>
              Probes: {protocol.freeReconProbes} free, max {protocol.maxReconProbes},{' '}
              {money(protocol.reconProbePrice)} after that. Delay {PROBE_DELAY_BLOCKS} blocks. A hint is two
              noisy angles — where the attack came from and where it lands — never a position. Opening sweep{' '}
              {BASE_CONE_DEGREES}°. Shared bias {ATTACK_BIAS_DEGREES}°. Fused cone never closes past{' '}
              {MIN_CONE_DEGREES}°. Same grid cell, same reading.
            </li>
            <li>
              Epoch {protocol.epochBlocks} blocks ({approxDuration(epochMs)}). If less than 90% of an epoch would
              remain after the deadline, a player room waits one more epoch. Grid {map.columns}×{map.rows}.
              Intercept radius {protocol.interceptionRadiusSectors} sectors.
            </li>
            <li>
              Jackpot every {protocol.globalDefenseEpochInterval} epochs ({approxDuration(jackpotMs)}). Join
              window {joinWindow}. Owner cannot withdraw the Global Defense pool.
            </li>
            <li>
              The attack&apos;s path, the probe answers and every Defense Point stay encrypted until impact. A
              hit is that one look at your submit block, not a wall standing on the path.
            </li>
          </ul>
        </section>
      </div>
    </details>
  )
}
