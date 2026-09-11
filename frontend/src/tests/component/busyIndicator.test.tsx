import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommandCenter, type CommandCenterProps } from '../../components/command/CommandCenter'
import railStyles from '../../components/command/CommandRail.module.css'
import { Button } from '../../components/common/Button'
import sweepStyles from '../../motion/BusySweep.module.css'

/**
 * ТЗ §8-§10 — one waiting state for the whole product.
 *
 * The product used to have four pictures of "working". CTAs still share
 * `BusySweep`. The probe dial is a ring on the glyph instead: a sweep over
 * that column painted a grey rectangle on the rail.
 */
function sweepsIn(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(`.${sweepStyles.sweep}`))
}

function reconScanIn(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(`.${railStyles.reconScan}`))
}

function renderCenter(overrides: Partial<CommandCenterProps> = {}) {
  const props: CommandCenterProps = {
    lobbyPhase: 'WAITING_FOR_ATTACK',
    probesAvailable: 3,
    probesUsed: 0,
    stagedPoint: null,
    submittedPoint: null,
    onSendRecon: vi.fn(),
    reconBlockedReason: null,
    isReconBusy: false,
    isReconSending: false,
    onSendDefense: vi.fn(),
    defenseBlockedReason: null,
    isDefenseBusy: false,
    canRequestReveal: false,
    onRequestReveal: vi.fn(),
    isRevealBusy: false,
    claims: [],
    ...overrides,
  }
  return render(<CommandCenter {...props} />)
}

describe('the busy indicator', () => {
  it('is absent until something is actually being waited on', () => {
    const { container } = render(<Button>Launch Defense</Button>)
    expect(sweepsIn(container)).toHaveLength(0)

    renderCenter()
    expect(sweepsIn(document.body)).toHaveLength(0)
  })

  it('puts a scan on the probe control rather than a sweep over the column', () => {
    const cta = render(
      <Button activity="busy" busyLabel="Confirming">
        Launch Defense
      </Button>,
    )
    expect(sweepsIn(cta.container)).toHaveLength(1)

    renderCenter({ isReconBusy: true, isReconSending: true })
    const probe = screen.getByRole('button', { name: /get recon/i })
    expect(sweepsIn(probe)).toHaveLength(0)
    expect(reconScanIn(probe)).toHaveLength(1)
  })

  /*
   * The wait belongs to the control that is waiting, and to no other. A
   * console with a probe in flight must not look like one that is also
   * sending a defense.
   */
  it('marks only the control that is waiting', () => {
    renderCenter({ isReconBusy: true, isReconSending: true })
    expect(sweepsIn(document.body)).toHaveLength(0)
    expect(reconScanIn(screen.getByRole('button', { name: /get recon/i }))).toHaveLength(1)
  })

  it('waits the same way on Intercept', () => {
    renderCenter({ isDefenseBusy: true, stagedPoint: { sector: { column: 2, row: 1 }, offsetX: 0.25, offsetY: 0.75 } })
    expect(sweepsIn(document.body)).toHaveLength(1)
  })

  it('waits the same way on Reveal', () => {
    renderCenter({ canRequestReveal: true, isRevealBusy: true })
    expect(sweepsIn(document.body)).toHaveLength(1)
  })

  it('waits the same way on a payout being settled', () => {
    renderCenter({
      lobbyPhase: 'RESULT',
      claims: [
        {
          key: 'reward',
          parts: ['prize'],
          note: 'Your share of the prize pool.',
          amount: 0.25,
          claimed: false,
          busy: true,
          error: null,
          onClaim: vi.fn(),
        },
      ],
    })
    expect(sweepsIn(document.body)).toHaveLength(1)
  })
})
