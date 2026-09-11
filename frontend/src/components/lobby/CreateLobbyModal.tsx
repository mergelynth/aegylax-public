import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { appConfig } from '../../config/env'
import { buildDefaultLobbyConfig } from '../../config/gameConfig'
import { deadlineBlockOf } from '../../game/epochs'
import { useBlockRate } from '../../hooks/useBlockRate'
import { useEpochClock } from '../../hooks/useEpochClock'
import { useLobbyActions } from '../../hooks/useLobbyActions'
import { useOperationLaunchCountdown } from '../../hooks/useOperationLaunchCountdown'
import { useWallet } from '../../hooks/useWallet'
import { useWalletBalance } from '../../hooks/useWalletBalance'
import { validateLobbyConfig, MAX_LOBBY_NAME_BYTES } from '../../game/lobby'
import type { LobbyConfig } from '../../game/types'
import { useUiStore } from '../../stores/uiStore'
import { formatDeadlineShort, formatEth } from '../../utils/format'
import { InterceptTimer } from '../attack/InterceptTimer'
import { ArcControl } from '../common/ArcControl'
import { Button } from '../common/Button'
import { CapacityRange } from '../common/CapacityRange'
import { DeadlineField } from '../common/DeadlineField'
import { Modal } from '../common/Modal'
import { ScrubField } from '../common/ScrubField'
import styles from './CreateLobbyModal.module.css'

/** ETH amounts are entered in ten-thousandths — one step is 0.0001 ETH. */
const ETH_STEP = 0.0001

/** Two digits, so the ends of the capacity rail keep one width: `02 … 20`. */
const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * ТЗ §9 — how long Launch has to be held.
 *
 * Two seconds, with a bar that fills across the button for the whole of
 * it. Four hundred milliseconds was a guard nobody could see, let alone
 * read; this is long enough that "Hold to launch" is an instruction and
 * the bar is the remaining wait, not a flash.
 */
const LAUNCH_HOLD_MS = 2000

/**
 * ETH held back for the transaction itself when deciding whether a wallet
 * can afford a launch.
 *
 * A reserve, not a quote. Nothing in `BlockchainClient` estimates fees —
 * there is no `estimateGas` to call and the emulator has no meaningful
 * answer to give — so this is a deliberately generous floor for an L2
 * `createLobby`, chosen so the check errs towards letting somebody try
 * rather than refusing a launch they could actually pay for.
 *
 * The wallet remains the authority on what a transaction costs. This exists
 * to catch the case that is certain to fail *before* it is signed: a creator
 * who has set a start pool larger than the wallet holds gets told so under
 * the field they set it in, instead of meeting an insufficient-funds revert
 * from their wallet with no idea which number to change.
 */
const GAS_RESERVE_ETH = 0.0002

/**
 * Create Operation — the console that launches an operation.
 *
 * The words here follow the product's one rule about its own vocabulary:
 * an *operation* is the thing you create, join and leave; a *defense* is
 * the thing you send inside one.
 *
 * The creator configures the name, economics and participation rules of
 * their own operation: player limits, entry fee, start prize pool,
 * application deadline and creator fee. They never touch the rules of the
 * game itself — the protocol creation fee, epoch length, attacks per epoch
 * and the Recon terms are not offered as inputs at all, because they are
 * not this creator's to set, and `validateLobbyConfig` re-checks every one
 * of them at creation.
 *
 * **Everything editable is on the screen at once.** The Advanced Settings
 * accordion this replaces failed twice over: it hid the creator fee — a
 * parameter that changes what every joiner pays — behind a disclosure most
 * people never opened, and expanding it resized the dialog under the
 * pointer, which is the layout shift ТЗ §16 exists to forbid. Nothing here
 * expands, and the error slot beside every control is reserved whether or
 * not there is an error in it.
 *
 * **Not everything shown is a setting.** ТЗ §17: a control implies a
 * choice, so a value the creator cannot change must not look like one. The
 * Recon row is a stated fact, and the launch summary is a read-back rather
 * than a second copy of the form.
 *
 * Two clocks live here and must not be confused:
 *   - the header block names the threat this operation will *intercept* and
 *     when it arrives, for the deadline currently in the form. Nothing on
 *     this screen creates an attack — the protocol was always sending one,
 *     and launching commits a room of defenders to meeting it. It is not
 *     the protocol's next attack either, and it can never reach zero (see
 *     `useOperationLaunchCountdown`);
 *   - "Application deadline" is a parameter of this operation — when
 *     joining closes.
 */
export function CreateLobbyModal() {
  const closeCreateLobbyModal = useUiStore((state) => state.closeCreateLobbyModal)
  const navigate = useNavigate()
  const { create } = useLobbyActions()
  const { address, isConnected, connect, status: walletStatus } = useWallet()
  const limits = appConfig.protocol
  // The two halves of "which block is that moment": where the chain is now,
  // and how fast it is actually moving.
  const { blockNumber } = useEpochClock()
  const blockTimeMs = useBlockRate(appConfig.blockTimeMs)

  /*
   * The blank template, unless whoever opened the dialog supplied terms.
   *
   * Read once, in the initialiser: the form is the creator's from the first
   * keystroke, and a prefill that kept re-applying would undo their edits.
   * `name` is the field the template deliberately leaves empty, so it is
   * usually the only one a caller has to fill.
   */
  const prefill = useUiStore.getState().createLobbyPrefill
  const [config, setConfig] = useState<LobbyConfig>(() => {
    const template = buildDefaultLobbyConfig(appConfig, Date.now())
    if (!prefill) return template
    return {
      ...template,
      ...prefill,
      participation: { ...template.participation, ...prefill.participation },
      economics: { ...template.economics, ...prefill.economics },
    }
  })
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [nameTouched, setNameTouched] = useState(false)
  /**
   * Why the sign-in that Launch depends on never started.
   *
   * Its own state rather than `create.error`: no transaction was attempted,
   * so there is nothing for the tx runner to report, and without it a
   * provider that refused to open its modal left Launch looking pressed and
   * ignored.
   */
  const [connectError, setConnectError] = useState<string | null>(null)
  /**
   * Pressed while the sign-in provider is still starting up.
   *
   * There is nothing to open yet — the SDK cannot accept a login until it
   * has restored its session, and asking it to is what used to make this
   * press do literally nothing. So the press is *taken* rather than
   * refused: the flag below is set, the button says it is waiting, and the
   * moment the provider is up the effect opens the sign-in that was asked
   * for.
   */
  const [awaitingProvider, setAwaitingProvider] = useState(false)

  const { participation, economics } = config

  /**
   * Validation's other input, and the only one that moves on its own.
   *
   * "The application deadline must be in the future" is not a fact about a
   * config, it is a fact about a config *and a moment* — and the moment
   * keeps arriving. A creator who sets a deadline a few minutes out, or who
   * simply leaves this form open, holds a config that becomes illegal with
   * nothing on the screen changing.
   *
   * Memoising the validation on the config alone froze the answer at
   * whatever it was when a field was last edited. Launch re-checked against
   * the real clock, found the config illegal and returned — while the
   * footer went on rendering the stale, empty error list, so the press
   * produced nothing at all: no error, no sign-in, no transaction. The
   * clock is a dependency of the validation because it is an argument to it.
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(tick)
  }, [])

  // Layer 2 of the validation model: the same validator the creation path
  // runs, evaluated live so every control explains itself before submission.
  const liveErrors = useMemo(() => validateLobbyConfig(config, now, limits), [config, now, limits])
  const errorFor = (field: string) => liveErrors.find((error) => error.field === field)?.message

  /*
   * The one field that opens empty, so unlike every other control it cannot
   * validate live from the first render — that would greet the creator with
   * an error they haven't earned. It stays quiet until they have touched it
   * or tried to launch, and is sticky from then on, so clearing the field
   * again shows the error rather than hiding it.
   */
  const nameError = nameTouched || submitAttempted ? errorFor('name') : undefined

  /**
   * Whether this wallet can actually pay for the launch it is configuring.
   *
   * Not part of `validateLobbyConfig`, and deliberately so: that validator
   * answers whether a config is *legal*, which is a fact about the config
   * and the protocol alone, and it is re-run on the write path where no
   * wallet balance exists to consult. Affordability is a fact about the
   * payer, it changes without the config changing, and it stops being true
   * the moment somebody tops up — so it belongs here, beside the field the
   * creator can act on, rather than in the protocol's rulebook.
   *
   * Only ever a *refusal to spend*, never a cap on the field. A protocol
   * limit is permanent and worth making unreachable, the way the player rail
   * clamps; a balance is transient, and a control that silently rewrote the
   * start pool when the balance dipped would be changing the creator's terms
   * behind their back.
   *
   * `null` balance means unknown, never zero — before the first read lands,
   * and in contract mode with no RPC. Refusing on unknown would block
   * launches for wallets with money in them.
   */
  const launchCost = economics.prizePool + economics.protocolJoinFee
  const balance = useWalletBalance(address)
  const affordabilityError = useMemo(() => {
    if (!isConnected || balance === null || launchCost + GAS_RESERVE_ETH <= balance) return undefined
    return `Not enough ETH — launching costs ${formatEth(launchCost)} plus gas, and this wallet holds ${formatEth(balance)}.`
  }, [isConnected, balance, launchCost])

  /** Everything that must be true before Launch may spend anything. */
  const blocked = liveErrors.length > 0 || affordabilityError !== undefined

  const setParticipation = (patch: Partial<LobbyConfig['participation']>) =>
    setConfig((c) => ({ ...c, participation: { ...c.participation, ...patch } }))
  const setEconomics = (patch: Partial<LobbyConfig['economics']>) =>
    setConfig((c) => ({ ...c, economics: { ...c.economics, ...patch } }))

  /**
   * Which threat this operation will meet, and when it arrives — for the
   * deadline sitting in the form right now, so the header answers the
   * question the creator is in the middle of deciding.
   */
  const launch = useOperationLaunchCountdown(participation.deadline)

  /**
   * The deadline the protocol will actually enforce, in blocks.
   *
   * The same conversion the header timer counts down through, so the epoch
   * shown beside the clock is the epoch this press books rather than a
   * second opinion about it. Zero when the chain's head has not been read:
   * `create.run` is what refuses in that case, not a guessed block.
   */
  const deadlineBlockFor = useCallback(
    (deadlineMs: number) => deadlineBlockOf({ nowMs: Date.now(), deadlineMs, blockNumber, blockTimeMs }) ?? 0,
    [blockNumber, blockTimeMs],
  )

  /**
   * Launch, once the config is legal and there is somebody to launch as.
   *
   * Kept apart from the press handler because that handler answers two
   * different presses — the sign-in and the launch — and only this half
   * spends anything.
   */
  const submit = useCallback(async () => {
    const submitted: LobbyConfig = {
      ...config,
      participation: {
        ...config.participation,
        deadlineBlock: deadlineBlockFor(config.participation.deadline),
      },
    }
    const lobby = await create.run(submitted)
    if (lobby) {
      closeCreateLobbyModal()
      navigate(`/lobby/${lobby.id}`)
    }
  }, [create, config, deadlineBlockFor, closeCreateLobbyModal, navigate])

  /**
   * Open the sign-in, and report a provider that would not open it.
   *
   * A rejected or abandoned sign-in leaves the form exactly as it was, so
   * the creator simply presses again. A sign-in that could not be *started*
   * is different, and has to say so: that press produced no modal, no
   * transaction and no error, which is the one outcome a creator cannot act
   * on.
   */
  const startConnect = useCallback(async () => {
    setConnectError(null)
    try {
      await connect()
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err))
    }
  }, [connect])

  /**
   * Set when the press that asked for sign-in arrived before the provider
   * was up. A ref rather than state: nothing renders differently for it —
   * `awaitingProvider` is what the button reads — and it must not be stale
   * inside the effect.
   */
  const connectWhenReady = useRef(false)

  useEffect(() => {
    if (walletStatus === 'initializing') return
    setAwaitingProvider(false)
    if (!connectWhenReady.current) return
    connectWhenReady.current = false
    void startConnect()
  }, [walletStatus, startConnect])

  /**
   * ТЗ §2, §9 — signing in and launching are two presses, and only the
   * second one is held.
   *
   * Pressing without a wallet opens sign-in and *keeps the form* — the
   * refusal this replaced ("Sign in before creating a lobby") was a dead end
   * at the worst possible moment, and everything the creator set is still
   * here because this modal never unmounts. What it no longer does is launch
   * on its own the instant the session lands: the hold is what stands
   * between a stray press and a start pool, and a sign-in that resumed
   * straight into a transaction skipped it entirely — money moved on a press
   * that was never held, at the end of a wallet flow that had taken the
   * creator's attention elsewhere. So the button arms its hold only once
   * there is somebody to spend as, and the launch is the press after that.
   */
  const handleSubmit = async () => {
    if (!isConnected) {
      // Nothing to open yet: wait for the provider rather than asking it to
      // do something it cannot, and let the effect above open the sign-in.
      if (walletStatus === 'initializing') {
        connectWhenReady.current = true
        setAwaitingProvider(true)
        return
      }
      await startConnect()
      return
    }

    setSubmitAttempted(true)
    /*
     * Layer 3 in the UI. The blockchain layer validates again on write —
     * that one, not this one, is what makes the limits unbypassable.
     *
     * Checked against the same moment the screen is then told to report, so
     * a press refused by the clock cannot leave the footer contradicting it.
     */
    const attemptedAt = Date.now()
    setNow(attemptedAt)
    if (validateLobbyConfig(config, attemptedAt, limits).length > 0) return
    /*
     * The wallet is short. Not re-derived from a validator, because no
     * validator knows about wallets — and it can only be asked here, where
     * a session exists: an unconnected visitor has no balance to check, and
     * the first read lands a moment after the sign-in does. A shortfall that
     * appears in that gap falls through to the wallet, which refuses to sign
     * and reports through `create.error`, and the field picks it up on the
     * next block.
     */
    if (affordabilityError) return

    await submit()
  }

  const isSubmitting = create.status === 'preparing' || create.status === 'pending'
  const blockedBySubmit = submitAttempted && blocked

  return (
    <Modal
      title="Create Operation"
      headerAccessory={
        <InterceptTimer msRemaining={launch.msRemaining} epochId={launch.epochId} launchBlock={launch.launchBlock} />
      }
      onClose={closeCreateLobbyModal}
      closeDisabled={isSubmitting || awaitingProvider}
    >
      <div className={styles.form} data-guide="create-form">
        {/*
          ТЗ §10 — the name inline, as a line of type with a signal edge
          under it, rather than a large empty box at the top of a form.
        */}
        <div className={`${styles.field} ${nameError ? styles.invalid : ''}`}>
          <label className={styles.label} htmlFor="operation-name">
            Operation name
          </label>
          <div className={styles.nameControl}>
            <input
              id="operation-name"
              className={styles.nameInput}
              type="text"
              value={config.name}
              maxLength={MAX_LOBBY_NAME_BYTES}
              placeholder="Name this operation"
              autoComplete="off"
              aria-describedby="operation-name-description"
              aria-invalid={nameError ? true : undefined}
              onChange={(e) => {
                setNameTouched(true)
                setConfig((c) => ({ ...c, name: e.target.value }))
              }}
            />
            <span className={styles.edge} aria-hidden="true" />
          </div>
          <span
            id="operation-name-description"
            className={styles.note}
            role={nameError ? 'alert' : undefined}
          >
            {nameError ?? 'Shown to everyone who opens this operation'}
          </span>
        </div>

        {/*
          ТЗ §4 — the room size as one range rather than two fields that
          constrain each other. "Between 2 and 20, out of a possible 2 to
          25" is a shape; as a pair of numbers it is arithmetic.
        */}
        <CapacityRange
          label="Players"
          handleLabels={['Min players', 'Max players']}
          lower={participation.minPlayers}
          upper={participation.maxPlayers}
          onChange={(minPlayers: number, maxPlayers: number) => setParticipation({ minPlayers, maxPlayers })}
          min={limits.minPlayers}
          max={limits.maxPlayers}
          readout={`${participation.minPlayers} – ${participation.maxPlayers}`}
          startLabel={pad2(limits.minPlayers)}
          endLabel={pad2(limits.maxPlayers)}
          hint="The round runs once the minimum is reached, and closes at the maximum"
          error={errorFor('participation.minPlayers') ?? errorFor('participation.maxPlayers')}
        />

        <div className={styles.pair}>
          <ScrubField
            label="Entry"
            value={participation.entryPrice}
            onChange={(entryPrice) => setParticipation({ entryPrice })}
            min={limits.minEntryPrice}
            max={limits.maxEntryPrice}
            step={ETH_STEP}
            suffix="ETH"
            hint="Paid by each participant"
            error={errorFor('participation.entryPrice')}
          />
          <ScrubField
            label="Start pool"
            value={economics.prizePool}
            onChange={(prizePool) => setEconomics({ prizePool })}
            min={limits.minStartPrizePool}
            step={ETH_STEP}
            suffix="ETH"
            hint={
              limits.minStartPrizePool > 0
                ? `Funded by you at launch · minimum ${formatEth(limits.minStartPrizePool)}`
                : 'Funded by you at launch'
            }
            /*
              The shortfall lands here rather than in the footer because this
              is the number the creator can move. The protocol's creation fee
              is the other half of the total and is not theirs to change.
            */
            error={errorFor('economics.prizePool') ?? affordabilityError}
          />
        </div>

        <div className={styles.pair}>
          <DeadlineField
            label="Application deadline"
            value={participation.deadline}
            onChange={(deadline) => setParticipation({ deadline })}
            hint="When applications for this operation close"
            error={errorFor('participation.deadline')}
          />
          {/*
            A share of an allowance, drawn as one. The protocol's ceiling is
            the end of the arc, so "how much of what I am allowed am I
            taking" needs no second number to read against — and unlike the
            capacity rail beside it, this value is a proportion rather than a
            count, which is what earns it a different shape.
          */}
          <ArcControl
            label="Creator fee"
            value={economics.creatorFeePercent}
            onChange={(creatorFeePercent: number) => setEconomics({ creatorFeePercent })}
            min={0}
            max={limits.maxCreatorFeePercent}
            readout={`${economics.creatorFeePercent}%`}
            startLabel="0%"
            endLabel={`${limits.maxCreatorFeePercent}%`}
            valueText={`${economics.creatorFeePercent} percent`}
            hint="Yours if the round starts, refunded to joiners if it does not"
            error={errorFor('economics.creatorFeePercent')}
          />
        </div>

        {/*
          ТЗ §8, §17 — a stated fact, not a control, because it is not the
          creator's to set.

          The epoch's attack is one threat every operation of that epoch is
          defending against, so a probe's answer is worth the same in all of
          them. A creator pricing recon here would not be pricing their own
          operation; they would be choosing where everybody buys the epoch's
          intelligence. The terms are still shown, because a creator should
          know what their defenders will be working with — and shown as a
          line of text, so nobody spends a moment wondering whether it is
          something they were meant to adjust.
        */}
        <p className={styles.protocolRow}>
          <span className={styles.label}>Recon</span>
          <span className={styles.protocolValue}>
            {limits.freeReconProbes} free · max {limits.maxReconProbes} · {formatEth(limits.reconProbePrice)} each after
          </span>
        </p>

        <hr className={styles.divider} />

        {/*
          ТЗ §11 — a short read-back, not the invoice this replaces.

          The old preview restated every parameter the form was already
          showing, plus a fee breakdown, directly underneath it. Four figures
          are enough: the one number that is not on the form anywhere (what
          this actually costs to launch) and the three a creator double-checks
          before spending it.
        */}
        <section className={styles.summary} aria-label="Launch summary">
          <dl className={styles.summaryList}>
            <div className={styles.summaryItem}>
              <dt className={styles.label}>Launch cost</dt>
              <dd className={styles.summaryCost}>{formatEth(launchCost)}</dd>
            </div>
            <div className={styles.summaryItem}>
              <dt className={styles.label}>Players</dt>
              <dd className={styles.summaryValue}>
                {participation.minPlayers}–{participation.maxPlayers}
              </dd>
            </div>
            <div className={styles.summaryItem}>
              <dt className={styles.label}>Entry</dt>
              <dd className={styles.summaryValue}>{formatEth(participation.entryPrice)}</dd>
            </div>
            <div className={styles.summaryItem}>
              <dt className={styles.label}>Deadline</dt>
              <dd className={styles.summaryValue}>{formatDeadlineShort(participation.deadline)}</dd>
            </div>
          </dl>
        </section>

        <div className={styles.footer}>
          {(create.error ?? connectError) ? (
            <span className={styles.footerError} role="alert">
              {create.error ?? connectError}
            </span>
          ) : blockedBySubmit ? (
            <span className={styles.footerError} role="alert">
              {liveErrors.length + (affordabilityError ? 1 : 0) === 1
                ? 'Fix the highlighted field to launch'
                : 'Fix the highlighted fields to launch'}
            </span>
          ) : null}
          {/*
            Cancel is the way out before money moves. Once Launch is
            preparing or sitting in front of the wallet, backing out of the
            dialog would hide a prompt that is still waiting — so both this
            and the × stay inert until that wait ends.
          */}
          <Button variant="ghost" onClick={closeCreateLobbyModal} disabled={isSubmitting || awaitingProvider}>
            Cancel
          </Button>
          {/*
            ТЗ §9 — the wait is narrated rather than frozen.

            `preparing` is this client building the transaction; `pending` is
            it sitting in front of the player's wallet waiting to be signed.
            Those are completely different things to be waiting on, and only
            one of them is something the player has to go and do — so they
            get different words. The button that used to say "Launching…"
            for both left somebody staring at this dialog while their wallet
            waited behind it.
          */}
          <Button
            variant="primary"
            data-guide="create-submit"
            onClick={handleSubmit}
            /*
              ТЗ §9 — the hold guards the spend, not the form, and not the
              sign-in.

              A press that cannot succeed should say so immediately: being
              made to hold for two seconds only to be told a field is
              wrong is a worse confirmation than none, and it teaches
              people to hold through the guard without reading. The same is
              true of a press with no wallet behind it — it opens sign-in and
              spends nothing, so holding it would guard a modal. The hold is
              asked for exactly when there is money at the end of it: a legal
              config, and somebody to pay for it.
            */
            holdMs={blocked || !isConnected ? 0 : LAUNCH_HOLD_MS}
            holdLabel="Hold to launch"
            activity={
              isSubmitting || awaitingProvider ? 'busy' : create.status === 'confirmed' ? 'success' : 'idle'
            }
            busyLabel={
              awaitingProvider ? 'Waiting for sign-in' : create.status === 'pending' ? 'Confirming' : 'Preparing'
            }
          >
            {/*
              What the press will actually do, said before it is pressed.

              A button reading "Launch Operation" that opens a sign-in
              instead is a promise it cannot keep at that moment; naming the
              step makes the two presses legible, and the label becomes the
              launch as soon as there is a wallet to launch with. "Sign in"
              is the wording the header uses in every configuration, for the
              same reason it does there — a player who signed in with an
              email has a wallet but never sees one.
            */}
            {isConnected ? 'Launch Operation' : 'Sign in to launch'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
