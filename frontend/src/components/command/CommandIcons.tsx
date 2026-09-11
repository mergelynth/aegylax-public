import styles from './CommandCenter.module.css'

/**
 * The console's icon set. One stroke weight, one 24-box, no fills except
 * where a shape has to read as solid at 14px — so a row of them reads as
 * one instrument panel rather than as clip art from five sources.
 */

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: 'false' as const,
}

export function ProbeIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/*
        The glyph's colours arrive through classes, not through `stroke=`
        attributes. A theme token has to reach these marks — they are the
        accent's smallest appearance in the product — and a CSS class is the
        one delivery that is unambiguously supported: `var()` inside an SVG
        presentation attribute is patchily implemented, and where it fails
        the whole declaration drops and the mark paints black.
      */}
      <defs>
        <linearGradient id="probe-mast" x1="12" y1="2" x2="12" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0" className={styles.probeStopSoft} />
          <stop offset="1" className={styles.probeStopAccent} />
        </linearGradient>
        <linearGradient id="probe-beam" x1="12" y1="16" x2="20" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0" className={styles.probeStopAccent} />
          <stop offset="1" className={styles.probeStopAccent} stopOpacity="0.15" />
        </linearGradient>
      </defs>

      {/* High-gain dish — the sensor, not a rotor. */}
      <ellipse cx="12" cy="13.2" rx="5.4" ry="2.15" className={styles.probeDish} />
      <path d="M6.7 13.2c.4 1.6 2.6 2.7 5.3 2.7s4.9-1.1 5.3-2.7" className={styles.probeDishRim} />

      {/* Antenna boom, pointing the way the probe looks. */}
      <path d="M12 13.2V4.4" stroke="url(#probe-mast)" />
      <circle cx="12" cy="4.1" r="1.2" className={styles.probeTip} />

      {/* The body itself, the one warm mark in the set. */}
      <rect x="10.15" y="12.1" width="3.7" height="6.4" rx="1.05" opacity="0.32" className={styles.probeBody} />
      <path d="M12 17.2l6.4 3.1" stroke="url(#probe-beam)" />
    </svg>
  )
}

/**
 * Reconnaissance, as a *readout* rather than as a button (ТЗ §3).
 *
 * `ProbeIcon` above is the control's glyph and paints its own colours; a
 * readout line must not, because the line's colour is what carries its
 * state. So the row gets its own mark: the same probe, drawn in one stroke
 * of `currentColor` at the scale the labels are set in.
 */
export function ScanIcon({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <ellipse cx="12" cy="13.4" rx="4.8" ry="1.9" opacity="0.7" />
      <path d="M12 13.4V4.6" />
      <circle cx="12" cy="4.4" r="1.15" fill="currentColor" stroke="none" />
      <rect x="10.4" y="12.4" width="3.2" height="5.4" rx="0.9" fill="currentColor" stroke="none" opacity="0.85" />
    </svg>
  )
}

/** Intelligence — a signal read off a trace. */
export function SignalIcon({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M2.5 14.5h3l2-5 3 8 2.5-6 2 3h6.5" />
    </svg>
  )
}

/** Defense — a shield, the thing the whole console exists to launch. */
export function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3l7 2.8v5.4c0 4.2-2.9 7.6-7 9.8-4.1-2.2-7-5.6-7-9.8V5.8L12 3z" />
    </svg>
  )
}

/** Defense Point — a marked coordinate, matching the crosshair on the grid. */
export function CrosshairIcon({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  )
}
