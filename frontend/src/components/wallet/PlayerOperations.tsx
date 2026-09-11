import { Link } from 'react-router-dom'
import { lobbyTitle, usePlayerLobbies, type PlayerLobby } from '../../hooks/useLobbyDirectory'
import styles from './PlayerOperations.module.css'

/**
 * The operations this wallet is in, inside the panel that is already about
 * this wallet.
 *
 * The hard part is what it does *not* show. A wallet that has played twenty
 * rounds has twenty operations, and a header dropdown is the wrong place for
 * a list of twenty anythings — it would push the deposit address, the top-up
 * and the record off the bottom of a panel whose whole job is to be glanced
 * at. So this shows the ones that are still going, capped at three, and
 * everything else becomes a single line with a count and a link to the
 * directory.
 *
 * That cap is the feature rather than a compromise. An operation still taking
 * applications or still in flight is something a player has to *return* to —
 * a defense to place, a probe left, a claim waiting. A finished one is
 * history, and history belongs on a page, not in a dropdown.
 */
export function PlayerOperations({ address, onNavigate }: { address: `0x${string}`; onNavigate: () => void }) {
  const { status, live, past } = usePlayerLobbies(address)

  // The emulator, or a build with no backend: no directory to link into.
  if (status !== 'ready') return null
  if (live.length === 0 && past.length === 0) return null

  const shown = live.slice(0, MAX_LIVE)
  const hidden = live.length - shown.length

  return (
    <section className={styles.operations}>
      <h3 className={styles.heading}>Your operations</h3>

      {shown.length > 0 ? (
        <ul className={styles.list}>
          {shown.map((lobby) => (
            <li key={lobby.id}>
              <Link to={`/lobby/${lobby.id}`} viewTransition className={styles.row} onClick={onNavigate}>
                <span className={`${styles.dot} ${lobby.status === 'open' ? styles.open : styles.active}`} aria-hidden="true" />
                <span className={styles.name}>{lobbyTitle(lobby)}</span>
                <span className={styles.state}>{describe(lobby)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <p className={styles.footer}>
        {/*
          One line for everything the list is not showing: the live ones that
          did not fit, and the finished ones that were never going to. Both
          are counts rather than entries, because a count is a reason to
          follow the link and an entry is a reason to read the dropdown.
        */}
        {hidden > 0 ? <span>{hidden} more live</span> : null}
        {hidden > 0 && past.length > 0 ? <span className={styles.sep} aria-hidden="true" /> : null}
        {past.length > 0 ? <span>{past.length} finished</span> : null}
        {(hidden > 0 || past.length > 0) && <span className={styles.sep} aria-hidden="true" />}
        <Link to="/operations" viewTransition className={styles.browse} onClick={onNavigate}>
          Browse all
        </Link>
      </p>
    </section>
  )
}

/** Three fits the panel without pushing the deposit address off the bottom. */
const MAX_LIVE = 3

/**
 * What this wallet still has to do there, in two words.
 *
 * "Yours" rather than a role badge: on an operation this wallet opened but
 * never took a seat in, the useful fact is that nobody else can be relied on
 * to finish it.
 */
function describe(lobby: PlayerLobby): string {
  if (lobby.status === 'open') return lobby.joined ? 'waiting to start' : 'yours · open'
  return lobby.joined ? 'in flight' : 'yours · in flight'
}
