import { useCallback, useEffect, useMemo, useState } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import { GuideSpotlight } from '../components/guide/GuideSpotlight'
import { HomePage } from '../pages/HomePage'
import { LobbyPage } from '../pages/LobbyPage'
import { OperationsPage } from '../pages/OperationsPage'
import { useUiStore, type LobbyConfigPrefill } from '../stores/uiStore'
import { ProviderThemeProvider } from '../theme'
import type { GuideChain } from './demoChain'
import { GuideProviders } from './GuideProviders'
import {
  guideSequence,
  isEntryBranch,
  type EntryBranch,
  type GuideBranch,
  type GuideRoom,
  type GuideStep,
  type OutcomeBranch,
} from './script'
import styles from './GuideApp.module.css'

export const GUIDE_PATH = '/guide'

/** Whether this document was loaded into the tour. Read once, at mount. */
export function isGuidePath(): boolean {
  return typeof window !== 'undefined' && window.location.pathname.replace(/\/+$/, '') === GUIDE_PATH
}

/**
 * The guided tour (ТЗ §25-§27).
 *
 * It is not a page *about* the product — it is the product, running on a
 * sandbox chain, with one overlay explaining what you are looking at. The
 * Home page, the Create dialog, the operations directory and the operation
 * screen below are the same components the app routes to. Nothing here is a
 * mock-up of any of them.
 *
 * Three small pieces make that work:
 *
 *   `GuideProviders` swaps the chain and the identity underneath, so every
 *     hook on every screen reads demo state through its normal path.
 *   `MemoryRouter` gives those screens a history that is not the window's.
 *     That is what keeps the address bar on `/guide` while the tour walks
 *     from the hero into a room and back, and why the tour is a separate
 *     application root rather than a route (see `App`).
 *   `data-guide` attributes on the real components are what the overlay
 *     points at.
 *
 * The clock is frozen (`autoMine: false`), so nothing on screen resolves,
 * expires or moves while somebody is reading — and Prev costs exactly what
 * Next does, because every step is a read rather than a transition.
 */
export function GuideApp() {
  const [index, setIndex] = useState(0)
  /*
   * The two decisions, held apart from the step.
   *
   * They are independent — how you got into the round and how it ended —
   * so a walk is one of each, and the sequence is assembled from them
   * rather than stored. Keeping them here rather than on the step is what
   * lets PREV work across a fork: going back past a choice leaves the
   * choice made, so the path behind you is the one you actually walked.
   */
  const [entry, setEntry] = useState<EntryBranch>('create')
  const [outcome, setOutcome] = useState<OutcomeBranch>('hit')

  const steps = useMemo(() => guideSequence(entry, outcome), [entry, outcome])
  const step = steps[Math.min(index, steps.length - 1)]

  /*
   * Leaving is a document load, deliberately.
   *
   * The tour replaced the app's router with its own, so there is no
   * client-side navigation that could get back to the real one. A full load
   * is also the honest end to a sandbox: the demo chain, the demo identity
   * and the frozen clock all go with it.
   */
  const exit = useCallback(() => {
    window.location.assign('/')
  }, [])

  /*
   * The way out of the last screen: back to the product, with the Create
   * dialog already open on arrival.
   *
   * A query parameter rather than the store, because leaving the tour is a
   * document load — it replaced the app's router with its own, so there is
   * no client-side navigation home and nothing in memory survives the trip.
   * `HomePage` reads the parameter and strips it.
   */
  const finish = useCallback(() => {
    window.location.assign('/?create=1')
  }, [])

  return (
    <ProviderThemeProvider>
      <GuideProviders>
        {({ chain, error }) => {
          if (error) {
            return (
              <div className={styles.status} role="alert">
                <p className={styles.statusTitle}>Link could not be established</p>
                <p className={styles.statusBody}>{error}</p>
                <button type="button" className={styles.statusExit} onClick={exit}>
                  Return to AEGYLAX
                </button>
              </div>
            )
          }

          if (!chain) {
            return (
              <div className={styles.status}>
                <p className={styles.statusTitle}>Establishing link…</p>
                <p className={styles.statusBody}>Preparing example operations.</p>
              </div>
            )
          }

          return (
            <MemoryRouter initialEntries={['/']}>
              <GuideStage
                chain={chain}
                entry={entry}
                steps={steps}
                step={step}
                index={index}
                onIndex={setIndex}
                onFinish={finish}
                onChoose={(branch: GuideBranch) => {
                  if (isEntryBranch(branch)) setEntry(branch)
                  else setOutcome(branch)
                  setIndex((current) => current + 1)
                }}
                onExit={exit}
              />
            </MemoryRouter>
          )
        }}
      </GuideProviders>
    </ProviderThemeProvider>
  )
}

/** The path inside the tour's own router that a step is shown at. */
function pathFor(chain: GuideChain, step: GuideStep, entry: EntryBranch): string {
  if (step.screen === 'operations') return '/operations'
  if (step.screen === 'lobby') {
    const id = roomId(chain, step.room, entry)
    return id ? `/lobby/${id}` : '/'
  }
  return '/'
}

/**
 * The room a step stands in.
 *
 * `entry` resolves against the path the visitor chose, which is what keeps
 * the steps just after the fork in the room they were already looking at.
 */
function roomId(chain: GuideChain, room: GuideRoom | undefined, entry: EntryBranch): string | null {
  if (!room) return null
  if (room === 'entry') return entry === 'create' ? chain.lobbies.mine : chain.lobbies.seated
  return chain.lobbies[room]
}

interface StageProps {
  chain: GuideChain
  entry: EntryBranch
  onFinish: () => void
  steps: GuideStep[]
  step: GuideStep
  index: number
  onIndex: (index: number) => void
  onChoose: (branch: GuideBranch) => void
  onExit: () => void
}

function GuideStage({ chain, entry, steps, step, index, onIndex, onChoose, onFinish, onExit }: StageProps) {
  const navigate = useNavigate()
  const openCreateWith = useUiStore((state) => state.openCreateLobbyModalWith)
  const closeCreate = useUiStore((state) => state.closeCreateLobbyModal)

  const path = pathFor(chain, step, entry)

  /*
   * The screen follows the step, in the tour's own history.
   *
   * `replace` rather than push: Prev is the step index, not the browser's
   * back stack, and letting a sixteen-step walk build sixteen history
   * entries would put the two in permanent disagreement.
   */
  useEffect(() => {
    navigate(path, { replace: true })
  }, [navigate, path])

  /*
   * Whether the Create dialog is up is part of the step, so the step is what
   * decides it. Opening it any other way — the hero's own button — is still
   * the product's normal path; the step that follows simply agrees with it.
   */
  useEffect(() => {
    if (step.createModal) openCreateWith(DEMO_TERMS)
    else closeCreate()
  }, [step.createModal, openCreateWith, closeCreate])

  const goTo = useCallback(
    (next: number) => onIndex(Math.min(steps.length - 1, Math.max(0, next))),
    [onIndex, steps.length],
  )

  return (
    <div className={styles.stage}>
      {/*
        The real shell: the real header, the real jackpot, the real Create
        dialog mount. It is inside the tour's providers, so every readout in
        it is the sandbox's.
      */}
      <AppShell>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/operations" element={<OperationsPage />} />
          <Route path="/lobby/:id" element={<LobbyPage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
      </AppShell>

      {/*
        The product is inert while the tour runs.
        
        One transparent sheet over everything, rather than `pointer-events`
        on the shell: the Create dialog and the command rail are portalled
        to `document.body`, so a rule scoped to the stage would leave
        exactly the two most pressable surfaces live. The tour's own card
        sits above this and is the only thing that takes a click.
        
        It is not only about preventing damage — the sandbox could absorb a
        press. It is that the tour narrates a sequence, and a visitor who
        joined a room out of order would be looking at a screen the script
        is not describing.
      */}
      <div className={styles.shield} aria-hidden="true" />

      <GuideSpotlight
        step={step}
        position={index + 1}
        total={steps.length}
        hasPrevious={index > 0}
        hasNext={index < steps.length - 1}
        onPrevious={() => goTo(index - 1)}
        onNext={() => goTo(index + 1)}
        onChoose={onChoose}
        onFinish={onFinish}
        onExit={onExit}
      />
    </div>
  )
}

/**
 * The terms the Create dialog opens on inside the tour.
 *
 * Only the fields a creator actually chooses. Everything else — the attack
 * rules, the protocol fee, the Recon Probe terms — comes from the template,
 * which reads them from the protocol, because they are not the creator's to
 * set and a demo that showed them as editable would teach the wrong thing.
 */
const DEMO_TERMS: LobbyConfigPrefill = {
  name: 'SILENT HORIZON',
  participation: { minPlayers: 2, maxPlayers: 8, entryPrice: 0.03 },
  economics: { prizePool: 0.05 },
}
