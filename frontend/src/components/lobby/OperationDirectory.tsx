import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatEth, formatLongCountdown } from '../../utils/format'
import {
  lobbyTitle,
  useLobbyDirectory,
  usePlayerLobbies,
  PAGE_SIZE,
  type LobbyStatus,
  type LobbySummary,
} from '../../hooks/useLobbyDirectory'
import { filterSummaries, tallySummaries } from '../../hooks/emulatorFold'
import { weiToEth } from '../../hooks/usePlayerRecord'
import { useCountdownClock } from '../../hooks/useSmoothCountdown'
import { useWallet } from '../../hooks/useWallet'
import { useUiStore } from '../../stores/uiStore'
import { Button } from '../common/Button'
import styles from './OperationDirectory.module.css'

/**
 * Where a visitor finds an operation to join.
 *
 * The directory is public: All is the default, and a wallet is not required
 * to browse. Mine is a second view of the same list — the rounds this
 * player opened or sat in — and only that view asks them to sign in.
 */

const SCOPES: { value: 'all' | 'mine'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'Mine' },
]

const FILTERS: { value: LobbyStatus | 'all'; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'active', label: 'Live' },
  { value: 'finished', label: 'Finished' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'all', label: 'Any' },
]

type DirectorySort = 'newest' | 'closing' | 'pool'

const SORTS: { value: DirectorySort; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'closing', label: 'Closing soon' },
  { value: 'pool', label: 'Prize pool' },
]

function poolWei(lobby: LobbySummary): bigint {
  const raw = lobby.rewardPoolWei ?? lobby.startPrizePoolWei
  try {
    return BigInt(raw)
  } catch {
    return 0n
  }
}

function sortLobbies(lobbies: LobbySummary[], sort: DirectorySort): LobbySummary[] {
  if (sort === 'newest') return lobbies
  const copy = [...lobbies]
  if (sort === 'closing') {
    copy.sort((a, b) => a.registrationDeadline - b.registrationDeadline)
  } else {
    copy.sort((a, b) => {
      const delta = poolWei(b) - poolWei(a)
      return delta > 0n ? 1 : delta < 0n ? -1 : 0
    })
  }
  return copy
}

export function OperationDirectory() {
  const [scope, setScope] = useState<'all' | 'mine'>('all')
  const [filter, setFilter] = useState<LobbyStatus | 'all'>('all')
  const [sort, setSort] = useState<DirectorySort>('newest')
  const [typed, setTyped] = useState('')
  const query = useDebounced(typed, 250)
  const { address, isConnected, connect, status: walletStatus } = useWallet()
  const directory = useLobbyDirectory(filter, query)
  const mine = usePlayerLobbies(address)
  const openCreate = useUiStore((state) => state.openCreateLobbyModal)

  const minePool = useMemo(() => [...mine.live, ...mine.past], [mine.live, mine.past])
  const mineRows = useMemo(
    () => (scope === 'mine' ? filterSummaries(minePool, filter, query) : []),
    [scope, minePool, filter, query],
  )
  const mineCounts = useMemo(
    () => tallySummaries(filterSummaries(minePool, 'all', query)),
    [minePool, query],
  )

  const signedOut = scope === 'mine' && !isConnected
  const status = signedOut ? 'ready' : scope === 'mine' ? mine.status : directory.status
  const lobbies = scope === 'mine' ? mineRows : directory.lobbies
  const total = scope === 'mine' ? mineRows.length : directory.total
  const tabCounts = signedOut ? null : scope === 'mine' ? (mine.status === 'ready' ? mineCounts : null) : directory.counts
  const syncing = scope === 'mine' ? false : directory.syncing
  const hasMore = scope === 'all' && directory.hasMore
  const loadingMore = scope === 'all' && directory.loadingMore
  const shown = useMemo(() => sortLobbies(lobbies, sort), [lobbies, sort])

  return (
    <article className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.kicker}>
          <Link to="/" viewTransition className={styles.back}>
            Home
          </Link>
        </p>
        <div className={styles.heroRow}>
          <div className={styles.heroCopy}>
            <h1 className={styles.title}>Operations</h1>
            <p className={styles.lede}>
              Every round the protocol has opened. Sign in only if you want to see yours.
            </p>
          </div>
          <div className={styles.heroActions}>
            {status === 'ready' && !signedOut ? (
              <p className={styles.count}>
                {total} {total === 1 ? 'round' : 'rounds'}
              </p>
            ) : null}
            <Button variant="primary" size="small" onClick={openCreate}>
              Create Operation
            </Button>
          </div>
        </div>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.toolbarTop}>
          <div className={`${styles.filters} ${styles.scopes}`} role="tablist" aria-label="Whose operations">
            {SCOPES.map((option) => (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={scope === option.value}
                className={`${styles.filter} ${scope === option.value ? styles.filterOn : ''}`}
                onClick={() => setScope(option.value)}
              >
                {option.label}
                {option.value === 'all' && directory.counts ? (
                  <span className={styles.filterCount}>{directory.counts.all}</span>
                ) : null}
                {option.value === 'mine' && isConnected && mine.status === 'ready' ? (
                  <span className={styles.filterCount}>{mine.live.length + mine.past.length}</span>
                ) : null}
              </button>
            ))}
          </div>

          <div className={styles.tools}>
            <input
              type="search"
              className={styles.search}
              placeholder="Search name or id"
              aria-label="Search operations"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />

            <label className={styles.sort}>
              <span className={styles.sortLabel}>Sort</span>
              <select
                className={styles.sortSelect}
                aria-label="Sort operations"
                value={sort}
                onChange={(event) => setSort(event.target.value as DirectorySort)}
              >
                {SORTS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className={styles.filters} role="tablist" aria-label="Filter operations">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={filter === option.value}
              className={`${styles.filter} ${filter === option.value ? styles.filterOn : ''}`}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
              {tabCounts ? (
                <span className={styles.filterCount}>
                  {option.value === 'all' ? tabCounts.all : tabCounts[option.value]}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {signedOut ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Sign in to see your rounds.</p>
          <p className={styles.note}>All operations stay on All — Mine is only the ones you joined or created.</p>
          <Button
            variant="primary"
            onClick={() => void connect()}
            disabled={walletStatus === 'initializing'}
          >
            Sign in
          </Button>
        </div>
      ) : status === 'unavailable' ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Can&apos;t load operations right now.</p>
          <p className={styles.note}>
            The operations index is not reachable from this tab. A round is still reachable by its own
            link.
          </p>
        </div>
      ) : status === 'loading' && !loadingMore ? (
        <ul className={styles.list} aria-busy="true" aria-label="Loading operations">
          {Array.from({ length: 8 }, (_, index) => (
            <li key={index} className={styles.skeleton} />
          ))}
        </ul>
      ) : lobbies.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>
            {query.trim()
              ? `Nothing matches “${query.trim()}”.`
              : scope === 'mine'
                ? "You haven't joined a round yet."
                : filter === 'open'
                  ? 'No operation is taking applications right now.'
                  : 'Nothing here yet.'}
          </p>
          <p className={styles.note}>
            {syncing
              ? 'Still reading the chain — operations will appear here in a moment.'
              : query.trim()
                ? 'Try another name, or clear the search.'
                : scope === 'mine'
                  ? 'Browse All to join one, or open a round yourself.'
                  : filter === 'open'
                    ? 'Opening one is how the next round starts.'
                    : 'Try a different filter, or open a round yourself.'}
          </p>
          {scope === 'mine' && !query.trim() ? (
            <Button variant="ghost" onClick={() => setScope('all')}>
              Browse all
            </Button>
          ) : filter === 'open' && !query.trim() && !syncing ? (
            <Button variant="primary" onClick={openCreate}>
              Create Operation
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <ul className={styles.list} data-guide="directory-list">
            {shown.map((lobby) => (
              <OperationCard key={lobby.id} lobby={lobby} />
            ))}
          </ul>

          {hasMore ? (
            <button type="button" className={styles.more} onClick={directory.loadMore} disabled={loadingMore}>
              {loadingMore ? 'Reading…' : `Show ${Math.min(PAGE_SIZE, total - lobbies.length)} more`}
            </button>
          ) : null}
        </>
      )}
    </article>
  )
}

function OperationCard({ lobby }: { lobby: LobbySummary }) {
  const now = useCountdownClock()
  const entry = weiToEth(lobby.entryPriceWei)
  const pool = lobby.rewardPoolWei === null ? null : weiToEth(lobby.rewardPoolWei)
  const full = lobby.maxPlayers !== null && lobby.participants >= lobby.maxPlayers
  const time = describeTiming(lobby, now)
  const action = describeAction(lobby, full, now)

  return (
    <li>
      <Link
        to={`/lobby/${lobby.id}`}
        viewTransition
        className={`${styles.card} ${lobby.status === 'open' ? styles.cardOpen : ''}`}
      >
        <div className={styles.cardTop}>
          <StateMark lobby={lobby} />
          {full && lobby.status === 'open' ? <span className={styles.full}>Full</span> : null}
        </div>

        <span className={styles.name}>{lobbyTitle(lobby)}</span>

        {lobby.status === 'open' && lobby.minPlayers !== null && lobby.participants < lobby.minPlayers ? (
          <p className={styles.need}>{describeNeed(lobby)}</p>
        ) : null}

        {lobby.maxPlayers !== null ? (
          <span className={styles.seats} aria-hidden="true">
            <span
              className={styles.seatsFill}
              style={{ width: `${Math.min(100, (lobby.participants / lobby.maxPlayers) * 100)}%` }}
            />
          </span>
        ) : null}

        <dl className={styles.stats}>
          <div className={styles.stat}>
            <dt>Players</dt>
            <dd>{describeSeats(lobby)}</dd>
          </div>
          {pool !== null ? (
            <div className={styles.stat}>
              <dt>Entry</dt>
              <dd>{formatEth(entry, 4)}</dd>
            </div>
          ) : null}
          <div className={styles.stat}>
            <dt>{time.label}</dt>
            <dd>{time.value}</dd>
          </div>
        </dl>

        <div className={styles.cardFoot}>
          <div className={styles.pay}>
            {pool === null ? (
              <>
                <span className={styles.priceLabel}>Entry</span>
                <span className={styles.price}>{formatEth(entry, 4)}</span>
              </>
            ) : (
              <>
                <span className={styles.priceLabel}>Pool</span>
                <span className={styles.price}>{formatEth(pool, 4)}</span>
              </>
            )}
          </div>
          <span className={`${styles.action} ${action.kind === 'join' ? styles.actionJoin : ''}`}>
            {action.label}
          </span>
        </div>
      </Link>
    </li>
  )
}

function describeNeed(lobby: LobbySummary): string {
  if (lobby.minPlayers === null) return ''
  const left = lobby.minPlayers - lobby.participants
  return left === 1 ? '1 of the minimum still needed to start' : `${lobby.participants} of ${lobby.minPlayers} needed to start`
}

function describeSeats(lobby: LobbySummary): string {
  if (lobby.maxPlayers === null) return String(lobby.participants)
  return `${lobby.participants} / ${lobby.maxPlayers}`
}

function describeAction(
  lobby: LobbySummary,
  full: boolean,
  now: number,
): { kind: 'join' | 'view'; label: string } {
  if (lobby.status === 'open') {
    if (full || lobby.registrationDeadline * 1000 - now <= 0) return { kind: 'view', label: 'View' }
    return { kind: 'join', label: 'Join' }
  }
  if (lobby.status === 'active') return { kind: 'view', label: 'Watch' }
  return { kind: 'view', label: 'View' }
}

function describeTiming(lobby: LobbySummary, now: number): { label: string; value: string } {
  if (lobby.status === 'open') {
    const remaining = lobby.registrationDeadline * 1000 - now
    return remaining > 0
      ? { label: 'Closes', value: formatLongCountdown(remaining) }
      : { label: 'Closes', value: 'applications closed' }
  }
  if (lobby.status === 'active') return { label: 'Status', value: 'attack in flight' }
  if (lobby.status === 'cancelled') return { label: 'Why', value: endingReason(lobby.endedReason) }
  return {
    label: 'Result',
    /*
     * Two words, not a sentence.
     *
     * This cell is one line with `text-overflow: ellipsis` and room for
     * about a dozen characters, so "the threat was stopped" reached the
     * card as "the threat …" — which says less than nothing, because the
     * reader can see it was cut and cannot tell which way it went. The
     * status pill above already carries INTERCEPTED / IMPACT; this row's
     * job is to say the same thing in the reader's language, and it can
     * only do that at a length the cell can hold.
     */
    value: lobby.intercepted ? 'Stopped' : 'Got through',
  }
}

/**
 * The contract's cancellation reason, at the width the card has.
 *
 * `LobbyCancelled` and `AttackExpired` carry a sentence — "minimum
 * defenders not reached" — and the cell truncated every one of them to
 * "minimum def…". Mapped rather than shortened by CSS because these three
 * are the whole set the protocol emits, and an unmapped one is far better
 * off as the honest word "Cancelled" than as a fragment.
 */
function endingReason(reason: string | null): string {
  switch (reason) {
    case 'minimum defenders not reached':
      return 'Too few'
    case 'no defender ever acted':
      return 'Unplayed'
    case 'no reveal within grace period':
      return 'No reveal'
    default:
      return 'Cancelled'
  }
}

function useDebounced(value: string, delayMs: number): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}

function StateMark({ lobby }: { lobby: LobbySummary }) {
  const words: Record<LobbyStatus, string> = {
    open: 'Open',
    active: 'Live',
    finished: lobby.intercepted ? 'Intercepted' : 'Impact',
    cancelled: 'Cancelled',
  }
  return (
    <span className={`${styles.state} ${styles[lobby.status]}`}>
      <span className={styles.dot} aria-hidden="true" />
      {words[lobby.status]}
    </span>
  )
}
