import type { ReactNode, SVGProps } from 'react'

function IconBase({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  )
}

/**
 * The Global Defense Status glyphs are deliberately drawn from
 * different visual families — craft, shield, reticle, burst, chain —
 * so the HUD row reads as distinct protocol facts rather than one
 * repeated shape in several colors. The jackpot cup sits beside the
 * protocol-status shield, not in this row.
 */

/** Attacks — a saucer silhouette with a signal beam underneath. */
export function AttacksIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M9 13c0-2.8 1.3-5 3-5s3 2.2 3 5" />
      <ellipse cx="12" cy="13" rx="7.2" ry="2.1" />
      <path d="M9.2 15.9 8 18M14.8 15.9 16 18M12 16.3v2.4" />
    </IconBase>
  )
}

/**
 * Defense operations — a shield inside a lock-on frame: defense that is
 * actively tracking something, which is what an operation is. The frame is
 * what keeps it distinct from the protocol-status shield in the same header
 * and from the intercepted reticle two metrics along.
 *
 * Five paths rather than two, and the split is not cosmetic: this is the one
 * glyph in the row that comes apart. The header's Defenses chip bursts every
 * ten seconds or so and the pieces are thrown clear of it
 * (`GlobalStatsHud.module.css`), so each bracket has to be its own element
 * to be thrown in its own direction — four corners in a single `d` are one
 * shape that can only move as one.
 *
 * The order is load-bearing and the stylesheet reads it positionally: shield
 * first, then the corners clockwise from top-left. That is what decides which
 * way each piece flies, so a path inserted in the middle of this list would
 * silently send the wrong corner the wrong way.
 */
export function DefensesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M12 6.1 7.5 7.8v3.8c0 3.1 1.9 5.3 4.5 6.1 2.6-.8 4.5-3 4.5-6.1V7.8Z" />
      <path d="M3.4 7.4V4.5H6" />
      <path d="M18 4.5h2.6v2.9" />
      <path d="M20.6 16.6v2.9H18" />
      <path d="M3.4 16.6v2.9H6" />
    </IconBase>
  )
}

/** Intercepted — a targeting reticle with a hit mark at its center. */
export function InterceptedIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="7.2" />
      <path d="M12 2.3v3M12 18.7v3M2.3 12h3M18.7 12h3" />
      <path d="M9.3 12.3l1.9 1.9L15 10.4" />
    </IconBase>
  )
}

/** Impacts — a crater in the surface, with the incoming trail and debris thrown clear of it. */
export function ImpactsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M3.4 19.4h17.2" />
      <path d="M7.2 19.4 9.7 15.6h4.6l2.5 3.8" />
      <path d="M12 3.4v4" />
      <path d="M7.1 6.9 9.2 9.8M16.9 6.9 14.8 9.8" />
    </IconBase>
  )
}

/** Epoch — linked blocks, the protocol's position along the chain. */
export function EpochIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <rect x="3.2" y="8.6" width="6.4" height="6.8" rx="1.3" />
      <rect x="14.4" y="8.6" width="6.4" height="6.8" rx="1.3" />
      <path d="M9.6 12h4.8" />
      <path d="M12 5.4v1.9M12 16.7v1.9" />
    </IconBase>
  )
}

/** Jackpot — a cup, the Global Defense prize rather than another lifetime counter. */
export function TrophyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M7.4 4.2h9.2v1.8c0 3.1-2.1 5.3-4.6 5.7-2.5-.4-4.6-2.6-4.6-5.7V4.2Z" />
      <path d="M7.4 5.5H5.3A1.9 1.9 0 0 0 3.4 7.4c0 1.7 1.2 3.1 2.8 3.5" />
      <path d="M16.6 5.5h2.1A1.9 1.9 0 0 1 20.6 7.4c0 1.7-1.2 3.1-2.8 3.5" />
      <path d="M12 11.7v2.4" />
      <path d="M10.2 14.1h3.6" />
      <path d="M9.6 19.6h4.8" />
      <path d="M10.4 16.2h3.2v3.4h-3.2Z" />
    </IconBase>
  )
}

/** Protocol status — a restrained shield outline, deliberately plain so the state color (not the glyph) carries the meaning. */
export function ProtocolShieldIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M12 3.2 5 5.8v5.4c0 4.6 3 7.8 7 9 4-1.2 7-4.4 7-9V5.8Z" />
      <path d="M9 12.1l2 2 4-4.2" />
    </IconBase>
  )
}
