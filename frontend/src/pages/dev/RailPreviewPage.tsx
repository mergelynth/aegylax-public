import { Link, useSearchParams } from 'react-router-dom'
import { CommandCenter, type CommandCenterProps } from '../../components/command/CommandCenter'
import type { ClaimItem } from '../../components/command/SettlementPanel'
import { EarthSpaceViewport } from '../../components/earth/EarthSpaceViewport'
import type { DefensePoint } from '../../game/types'
import styles from './RailPreviewPage.module.css'

/**
 * DEV-only: sit the real command rail on Earth in every chassis state.
 * Production builds drop the route. Not linked from the product nav.
 */
const POINT: DefensePoint = { sector: { column: 2, row: 1 }, offsetX: 0.25, offsetY: 0.75 }

const noop = () => undefined

const STAGES = [
  'idle',
  'ready',
  'lock',
  'firing',
  'fired',
  'recon',
  'scan',
  'cooldown',
  'reveal',
  'decoding',
  'revealing',
  'reward',
  'miss',
  'escaped',
  'refund',
  'claimed',
  'signin',
  'fee',
  'error',
] as const

type Stage = (typeof STAGES)[number]

function claim(overrides: Partial<ClaimItem>): ClaimItem {
  return {
    key: 'reward',
    parts: ['prize'],
    note: 'Your share of the prize pool.',
    amount: 0.0026,
    claimed: false,
    busy: false,
    error: null,
    onClaim: noop,
    ...overrides,
  }
}

function propsFor(stage: Stage): CommandCenterProps {
  const base: CommandCenterProps = {
    lobbyPhase: 'ATTACK_ACTIVE',
    potEth: 0.0032,
    probesAvailable: 3,
    probesUsed: 0,
    probesMax: 6,
    stagedPoint: null,
    submittedPoint: null,
    onSendRecon: noop,
    reconBlockedReason: null,
    isReconBusy: false,
    isReconSending: false,
    onSendDefense: noop,
    defenseBlockedReason: null,
    isDefenseBusy: false,
    canRequestReveal: false,
    onRequestReveal: noop,
    isRevealBusy: false,
    claims: [],
  }

  switch (stage) {
    case 'idle':
      return { ...base, defenseBlockedReason: 'Place a point first' }
    case 'ready':
      return { ...base, stagedPoint: POINT }
    case 'lock':
      return { ...base, stagedPoint: POINT, isDefenseArming: true }
    case 'firing':
      return { ...base, stagedPoint: POINT, isDefenseBusy: true }
    case 'fired':
      return { ...base, stagedPoint: POINT, submittedPoint: POINT }
    case 'recon':
      return { ...base, stagedPoint: POINT, isReconBusy: true, probesAvailable: 2, probesUsed: 1 }
    case 'scan':
      return {
        ...base,
        stagedPoint: POINT,
        isReconBusy: true,
        isReconSending: true,
        probesAvailable: 2,
        probesUsed: 1,
      }
    case 'cooldown':
      return {
        ...base,
        stagedPoint: POINT,
        reconBlockedReason: 'Next probe in 2 blocks',
        probesAvailable: 2,
        probesUsed: 1,
      }
    case 'reveal':
      return { ...base, lobbyPhase: 'RESULT', canRequestReveal: true }
    // The keeper carrying it, with nobody having pressed anything — the
    // state a finished round is normally in for its first few seconds.
    case 'decoding':
      return { ...base, lobbyPhase: 'RESULT', canRequestReveal: true, revealAuto: true }
    case 'revealing':
      return { ...base, lobbyPhase: 'RESULT', canRequestReveal: true, isRevealBusy: true }
    case 'reward':
      return { ...base, lobbyPhase: 'RESULT', claims: [claim({})], ownHit: true, attackIntercepted: true }
    case 'miss':
      return { ...base, lobbyPhase: 'RESULT', attackIntercepted: true, ownHit: false }
    case 'escaped':
      return { ...base, lobbyPhase: 'RESULT', attackIntercepted: false, ownHit: false }
    case 'refund':
      return {
        ...base,
        lobbyPhase: 'CANCELLED',
        claims: [claim({ key: 'refund', parts: ['entry'], note: 'Your entry, returned.', amount: 0.0006 })],
      }
    case 'claimed':
      return { ...base, lobbyPhase: 'RESULT', claims: [claim({ claimed: true })], ownHit: true, attackIntercepted: true }
    case 'signin':
      return { ...base, onSignIn: noop }
    case 'fee':
      /* The creator of a round nobody intercepted: owed the Creator Fee and
         nothing else, which the rail used to call a reward. */
      return {
        ...base,
        lobbyPhase: 'RESULT',
        attackIntercepted: false,
        ownHit: false,
        claims: [
          claim({
            parts: ['fee'],
            amount: 0.0001,
            note:
              'You are paid 5% of the entry fees for creating this operation. This is a payout, not a charge: it is owed to you whether or not you intercepted the attack.',
          }),
        ],
      }
    case 'error':
      return { ...base, stagedPoint: POINT, error: 'Failed to fetch' }
  }
}

export function RailPreviewPage() {
  const [params] = useSearchParams()
  const raw = params.get('s')
  const stage: Stage = STAGES.includes(raw as Stage) ? (raw as Stage) : 'ready'

  return (
    <EarthSpaceViewport variant="hero">
      <nav className={styles.strip} aria-label="Rail preview stages">
        {STAGES.map((id) => (
          <Link key={id} to={`?s=${id}`} data-active={id === stage ? 'true' : undefined}>
            {id}
          </Link>
        ))}
      </nav>
      <CommandCenter {...propsFor(stage)} />
    </EarthSpaceViewport>
  )
}
