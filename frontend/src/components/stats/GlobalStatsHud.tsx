import { useEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode, type SVGProps } from 'react'
import { NavLink } from 'react-router-dom'
import { useBootEntrance } from '../../motion/useBootEntrance'
import { useCountUp } from '../../motion/useCountUp'
import { useGlitchBurst } from '../../motion/useGlitchBurst'
import { useGlobalStats } from '../../hooks/useGlobalStats'
import { useNextAttackCountdown } from '../../hooks/useNextAttackCountdown'
import { formatCountdown } from '../../utils/format'
import styles from './GlobalStatsHud.module.css'
import { AttacksIcon, DefensesIcon, EpochIcon, ImpactsIcon, InterceptedIcon } from './StatusIcons'

interface HudMetricProps {
  label: string
  description: string
  value: number | string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  /** Selects the metric's icon color and number weight — see the `tone` blocks in the stylesheet. */
  tone: 'attacks' | 'defenses' | 'intercepted' | 'impacts' | 'epoch'
  valuePrefix?: string
  /**
   * Position in the row, which is the *only* thing that differs between
   * these five entrances (ТЗ §6). It becomes `--boot-index` and staggers
   * the icon's activation 70ms per channel, so the HUD lights left to right
   * rather than all at once — telemetry coming online, not five icons
   * appearing. See `app/motion.css`.
   */
  index: number
  /**
   * Turns this metric into a control. Only Defenses uses it — that count
   * *is* the directory of operations, so the glyph that already names them
   * is the way in, rather than a second icon parked next to the wallet.
   */
  to?: string
  linkLabel?: string
}

/** How long the shake and its glow run for. */
const ALERT_MS = 620

/**
 * Icon + number are always visible; the full name and its meaning appear in
 * the tooltip on hover/focus (spec §12).
 *
 * ТЗ §7 — the reaction, and the whole of what triggers it: **this metric's
 * own number changed**. The icon takes the diagonal shake and its neon
 * glow, the figure beside it flashes, and a metric whose count did not move
 * does nothing at all.
 *
 * That is a narrower rule than the one it replaces, deliberately. The row
 * used to react to an *epoch closing*, which meant the attack icon shook
 * whether or not its counter had moved, and a browser that had been away
 * long enough for the epoch to advance performed the whole animation on
 * arrival — a page load looked like an event. Tying it to the digits means
 * the animation can only ever be a consequence of something the viewer can
 * see change.
 *
 * The first value is never a change: every metric starts at "—" and is
 * filled in when the chain answers, and the row lighting up on first paint
 * is that same page-load bug in its smallest form.
 */
function HudMetric({
  label,
  description,
  value,
  icon: Icon,
  tone,
  valuePrefix,
  index,
  to,
  linkLabel,
}: HudMetricProps) {
  const previous = useRef(value)
  const [alerting, setAlerting] = useState(false)
  /*
   * ТЗ §5 — the figure is run up to once, when the chain first answers, and
   * is the plain number for ever after.
   *
   * The count is on the *display* only: `value` below is still what decides
   * whether this metric alerts and what a screen reader is told, so a
   * counter rolling through 37 on its way to 97 never announces 37 and
   * never mistakes its own roll for the number having moved.
   */
  const shown = useCountUp(value, useBootEntrance())
  /*
   * ТЗ §7 — the periodic glitch, on the one metric that is a control.
   *
   * Gated on three things, and each of them is a state where a burst would
   * be saying something untrue. Only the metric that navigates (`to`): the
   * other four report, and a readout that comes apart on its own is claiming
   * to be interactive. Only once the chain has answered with a real number:
   * noise over the "—" placeholder would be inventing digits for a figure
   * that has not arrived. And never over an alert: `.alerting` is already
   * shaking these same elements to say the count moved, and two animations
   * on one transform is the one that fires second, not both.
   */
  const glitch = useGlitchBurst({
    text: String(shown),
    enabled: Boolean(to) && typeof value === 'number' && !alerting,
  })

  useEffect(() => {
    const before = previous.current
    previous.current = value
    if (before === value) return
    // Arriving at the first real figure is the read completing, not the
    // number moving — there was nothing there before to move from.
    if (typeof before !== 'number') return

    setAlerting(true)
    const timeout = setTimeout(() => setAlerting(false), ALERT_MS)
    return () => clearTimeout(timeout)
  }, [value])

  const classes = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(' ')
  const inner: ReactNode = (
    <>
      <Icon
        className={classes(styles.icon, 'boot-icon', 'motion-icon', alerting && styles.alerting)}
        style={{ ['--boot-index' as string]: index } as CSSProperties}
        aria-hidden="true"
      />
      {/* ТЗ §26 — brightens with its own glyph under the pointer, and
          nothing more than that. */}
      <span className={classes(styles.value, 'motion-glow', alerting && styles.flash)}>
        {valuePrefix ? <span className={styles.valuePrefix}>{valuePrefix}</span> : null}
        {to ? glitch.text : shown}
      </span>
      <span className={styles.tooltip} role="tooltip">
        <span className={styles.tooltipLabel}>{label}</span>
        <span className={styles.tooltipDescription}>{description}</span>
      </span>
    </>
  )

  if (to) {
    return (
      <NavLink
        to={to}
        viewTransition
        className={({ isActive }) =>
          classes(styles.metric, styles[tone], styles.metricLink, isActive && styles.metricOn)
        }
        // The whole chip is already named for where it goes, so the noise in
        // the count is never read out — it is not in the accessible name.
        aria-label={linkLabel ?? `${label}: ${value}`}
        data-glitch={glitch.active ? 'true' : undefined}
        style={glitch.style}
      >
        {inner}
      </NavLink>
    )
  }

  return (
    <span
      className={classes(styles.metric, styles[tone])}
      tabIndex={0}
      aria-label={`${label}: ${value}`}
    >
      {inner}
    </span>
  )
}

/**
 * The protocol's global status line, in lifecycle order: how many attacks
 * the protocol has generated, how many defense operations were created
 * against them, how many were intercepted, how many landed — and which
 * epoch the protocol is in right now.
 *
 * Every value is a canonical field of `GameStats`, read push-driven through
 * `useGlobalStats` (no polling, no client-side accumulation of events —
 * local counters would diverge across tabs and reset on reload). There is
 * deliberately no "active threats" metric: the protocol has exactly one
 * unresolved attack at a time, so `ATTACKS - (INTERCEPTED + IMPACTS)`
 * already expresses it.
 *
 * No visible "Global Defense Status" kicker — the icon row reads as a
 * status block on its own — but the group keeps that name for assistive
 * tech via `aria-label`.
 *
 * ТЗ §7 — the row is also where an outcome is *announced*, and each metric
 * announces its own: the icon shakes and glows exactly when its figure
 * moves, and never otherwise. See `HudMetric`.
 */
export function GlobalStatsHud() {
  const stats = useGlobalStats()
  const msUntilNextAttack = useNextAttackCountdown()

  return (
    <div className={styles.hud} aria-label="Global Defense Status">
      <div className={styles.metrics}>
        <HudMetric
          index={0}
          tone="attacks"
          label="Attacks"
          description="Attacks Detected"
          value={stats?.totalAttacks ?? '—'}
          icon={AttacksIcon}
        />
        <HudMetric
          index={1}
          tone="defenses"
          label="Defenses"
          description="Open the operations directory"
          value={stats?.totalLobbies ?? '—'}
          icon={DefensesIcon}
          to="/operations"
          linkLabel="Operations"
        />
        <HudMetric
          index={2}
          tone="intercepted"
          label="Intercepted"
          description="Intercepted"
          value={stats?.interceptedAttacks ?? '—'}
          icon={InterceptedIcon}
        />
        <HudMetric
          index={3}
          tone="impacts"
          label="Impacts"
          description="Impacts"
          value={stats?.missedAttacks ?? '—'}
          icon={ImpactsIcon}
        />
        <HudMetric
          index={4}
          tone="epoch"
          label="Epoch"
          description={`Next attack in ${msUntilNextAttack === null ? '--:--:--' : formatCountdown(msUntilNextAttack)}`}
          value={stats?.currentEpoch ?? '—'}
          icon={EpochIcon}
          valuePrefix={stats ? '#' : undefined}
        />
      </div>
    </div>
  )
}
