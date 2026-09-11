import { act, fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CreateLobbyModal } from '../../components/lobby/CreateLobbyModal'
import { appConfig } from '../../config/env'
import * as lobbyActions from '../../hooks/useLobbyActions'
import { formatDeadlineParts, formatEth } from '../../utils/format'
import { setStorageItem } from '../../utils/storage'
import { renderWithProviders } from '../testUtils'

const limits = appConfig.protocol
/** What `buildDefaultLobbyConfig` opens the deadline on, unless the protocol caps it sooner. */
const oneDayMs = Math.min(24 * 60 * 60 * 1000, limits.maxRegistrationDurationMs)

/**
 * Open the dialog as somebody who is already signed in.
 *
 * The local identity restores its session from storage, so seeding the flag
 * before the render is the same thing as having connected earlier — which is
 * the state every assertion about *launching* is about. A signed-out press
 * never reaches the form's rules at all: it opens sign-in.
 */
function renderSignedIn() {
  setStorageItem('emulator-wallet-connected', true)
  return renderWithProviders(<CreateLobbyModal />)
}

/** A scrubbed amount — an ETH figure, which is still a spinbutton to type into. */
function amountFor(name: RegExp): HTMLElement {
  return screen.getByRole('spinbutton', { name })
}

/** A slider handle. */
function handleFor(name: RegExp): HTMLElement {
  return screen.getByRole('slider', { name })
}

/** The hint/error line a control points at through `aria-describedby`. */
function descriptionOf(control: HTMLElement): HTMLElement {
  const id = control.getAttribute('aria-describedby')
  const description = id ? document.getElementById(id) : null
  if (!description) throw new Error('Control has no aria-describedby target')
  return description
}

/** What a `datetime-local` input holds for a given instant, in local time. */
function toLocalDatetimeValue(ms: number): string {
  return new Date(ms - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

describe('<CreateLobbyModal /> — Create Operation', () => {
  /*
   * ТЗ §2 — the accordion is gone, and with it the two problems it had:
   * the creator fee (a parameter that changes what every joiner pays) was
   * hidden behind a disclosure, and opening it resized the dialog.
   */
  it('puts every parameter the creator owns on the screen at once', () => {
    renderWithProviders(<CreateLobbyModal />)

    expect(handleFor(/min players/i)).toBeVisible()
    expect(handleFor(/max players/i)).toBeVisible()
    expect(handleFor(/creator fee/i)).toBeVisible()
    expect(amountFor(/^entry$/i)).toBeVisible()
    expect(amountFor(/start pool/i)).toBeVisible()
    // The deadline's own control is the native picker, deliberately
    // transparent behind the readout it drives (ТЗ §9) — so what has to be on
    // the screen is the moment, not the input.
    expect(screen.getByLabelText(/application deadline/i)).toBeInTheDocument()
    expect(screen.getByText(formatDeadlineParts(Date.now() + oneDayMs).date)).toBeInTheDocument()
    expect(screen.getByLabelText(/operation name/i)).toBeVisible()

    expect(screen.queryByText(/advanced settings/i)).not.toBeInTheDocument()
  })

  /*
   * ТЗ §17 — a control implies a choice. Recon is protocol-owned (one threat
   * per epoch means a probe is worth the same in every operation facing it),
   * so its terms are stated rather than offered.
   */
  it('states the protocol’s recon terms instead of offering them as controls', () => {
    renderWithProviders(<CreateLobbyModal />)

    expect(screen.queryByLabelText(/free recon probes/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/max recon probes/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/recon probe price/i)).not.toBeInTheDocument()

    expect(
      screen.getByText(
        `${limits.freeReconProbes} free · max ${limits.maxReconProbes} · ${formatEth(limits.reconProbePrice)} each after`,
      ),
    ).toBeInTheDocument()
  })

  it('never offers protocol-controlled rules as inputs', () => {
    renderWithProviders(<CreateLobbyModal />)

    expect(screen.queryByLabelText(/protocol join fee/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/epoch length/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/attacks per epoch/i)).not.toBeInTheDocument()
  })

  it('titles the modal "Create Operation" and keeps the countdown out of the accessible name', () => {
    renderWithProviders(<CreateLobbyModal />)

    const dialog = screen.getByRole('dialog', { name: 'Create Operation' })
    expect(within(dialog).getByRole('heading')).toHaveTextContent(/^Create Operation$/)
  })

  /*
   * The header clock is about *this* operation, not the protocol — and it
   * frames the operation as the interception it is.
   *
   * It used to show the next epoch boundary, minutes away, beside a form
   * whose default deadline is a day out: a creator was told their attack was
   * imminent when the truth was a day and a half off, and told it was
   * *their* attack when nothing on this screen creates one. It now counts to
   * the threat the current deadline would commit them to meeting, and names
   * the epoch it flies in.
   */
  it('names the threat this operation will intercept, and when it arrives', () => {
    renderWithProviders(<CreateLobbyModal />)

    expect(screen.getByText(/this operation intercepts/i)).toBeInTheDocument()
    expect(screen.queryByText(/attack launch/i)).not.toBeInTheDocument()
    // Either a real countdown or the honest placeholder while the block
    // clock is still being read — never a guess from local time.
    expect(screen.getByText(/^(\d+d )?(\d{2}:\d{2}:\d{2}|--:--:--)$/)).toBeInTheDocument()
    expect(screen.getByText(/^(≈ Epoch \d+|Epoch —)$/)).toBeInTheDocument()
  })

  it('explains each constraint under its control', () => {
    renderWithProviders(<CreateLobbyModal />)

    expect(descriptionOf(handleFor(/min players/i))).toHaveTextContent(/the round runs once the minimum is reached/i)
    expect(descriptionOf(amountFor(/^entry$/i))).toHaveTextContent(/paid by each participant/i)
    expect(descriptionOf(amountFor(/start pool/i))).toHaveTextContent(/funded by you at launch/i)
    expect(descriptionOf(handleFor(/creator fee/i))).toHaveTextContent(/yours if the round starts/i)
    expect(screen.getByText(/when applications for this operation close/i)).toBeInTheDocument()
  })

  /*
   * ТЗ §4 — direct manipulation makes the illegal states unreachable rather
   * than reporting them. The handles clamp against each other and against
   * the protocol range, so "max below min" and "more players than the
   * protocol allows" are shapes this control cannot express.
   *
   * `validateLobbyConfig` still rejects them, because a config can arrive
   * from somewhere other than this screen — see the lobby validation suite.
   */
  it('keeps the player range inside the protocol’s, and stops the handles crossing', () => {
    renderWithProviders(<CreateLobbyModal />)

    const min = handleFor(/min players/i)
    const max = handleFor(/max players/i)
    expect(min).toHaveAttribute('min', String(limits.minPlayers))
    expect(max).toHaveAttribute('max', String(limits.maxPlayers))

    fireEvent.change(max, { target: { value: String(limits.minPlayers) } })
    fireEvent.change(min, { target: { value: String(limits.maxPlayers) } })

    expect(Number((min as HTMLInputElement).value)).toBeLessThanOrEqual(Number((max as HTMLInputElement).value))
  })

  it('flags an entry fee outside the protocol range', () => {
    renderWithProviders(<CreateLobbyModal />)

    fireEvent.change(amountFor(/^entry$/i), { target: { value: String(limits.maxEntryPrice + 1) } })

    expect(descriptionOf(amountFor(/^entry$/i))).toHaveTextContent(/entry fee must be between/i)
  })

  it('flags a start pool below the protocol minimum', () => {
    renderWithProviders(<CreateLobbyModal />)

    fireEvent.change(amountFor(/start pool/i), { target: { value: '-1' } })

    expect(descriptionOf(amountFor(/start pool/i))).toHaveAttribute('role', 'alert')
  })

  /*
   * The fee is an arc rather than a rail, because it is a proportion of an
   * allowance rather than a count. It is an ARIA slider all the same, so the
   * protocol's ceiling is the end of the arc and there is no way to express
   * a fee above it.
   */
  it('caps the creator fee at the protocol maximum instead of letting it be exceeded', () => {
    renderWithProviders(<CreateLobbyModal />)

    expect(handleFor(/creator fee/i)).toHaveAttribute('aria-valuemax', String(limits.maxCreatorFeePercent))
    expect(handleFor(/creator fee/i)).toHaveAttribute('aria-valuemin', '0')
  })

  it('drives the creator fee arc from the keyboard, and stops at both ends', () => {
    renderWithProviders(<CreateLobbyModal />)
    const fee = handleFor(/creator fee/i)

    fireEvent.keyDown(fee, { key: 'End' })
    expect(fee).toHaveAttribute('aria-valuenow', String(limits.maxCreatorFeePercent))
    fireEvent.keyDown(fee, { key: 'ArrowRight' })
    expect(fee).toHaveAttribute('aria-valuenow', String(limits.maxCreatorFeePercent))

    fireEvent.keyDown(fee, { key: 'Home' })
    expect(fee).toHaveAttribute('aria-valuenow', '0')
    fireEvent.keyDown(fee, { key: 'ArrowDown' })
    expect(fee).toHaveAttribute('aria-valuenow', '0')
  })

  /*
   * ТЗ §9 — Launch spends a start pool plus the protocol's creation fee, so a
   * pointer press has to be held before it counts. The hold is dropped the
   * moment the config is illegal: making somebody hold for two seconds
   * to be told a field is wrong is a worse confirmation than none, and it
   * teaches people to hold through the guard without reading.
   */
  it('asks Launch to be held, but only while there is a legal config to spend on', () => {
    vi.useFakeTimers()
    try {
      renderSignedIn()
      const button = screen.getByRole('button', { name: /launch operation/i })

      // No name yet: the press must report the problem straight away.
      fireEvent.pointerDown(button, { button: 0 })
      expect(screen.queryByText(/hold to launch/i)).not.toBeInTheDocument()
      fireEvent.pointerUp(button)

      fireEvent.change(screen.getByLabelText(/operation name/i), { target: { value: 'Orbital Watch' } })

      fireEvent.pointerDown(button, { button: 0 })
      expect(screen.getByText(/hold to launch/i)).toBeInTheDocument()

      // Let go early: nothing is spent, but the instruction stays long
      // enough to read. A click that fails the hold used to snap the
      // label back instantly, which made "Hold to launch" unreadable.
      fireEvent.pointerUp(button)
      expect(screen.getByText(/hold to launch/i)).toBeInTheDocument()
      expect(screen.queryByText(/preparing|confirming/i)).not.toBeInTheDocument()
      act(() => void vi.advanceTimersByTime(2000))
      expect(screen.queryByText(/hold to launch/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/preparing|confirming/i)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  /*
   * ТЗ §2, §9 — signing in and launching are two presses, and only the
   * second one is held.
   *
   * A signed-out press has no transaction at the end of it: it opens
   * sign-in, so holding it would be guarding a modal. Worse, the sign-in
   * used to resume straight into the launch — money moved on a press that
   * was never held, at the end of a wallet flow that had taken the creator's
   * attention elsewhere. The form survives the sign-in either way, which is
   * the part worth keeping; the spend now waits for a press of its own.
   */
  it('opens sign-in on the first press, and asks for the hold only once there is a wallet', async () => {
    const idle = { status: 'idle' as const, error: null, run: vi.fn() }
    const run = vi.fn(async () => null)
    const spy = vi.spyOn(lobbyActions, 'useLobbyActions').mockReturnValue({
      create: { status: 'idle', error: null, run },
      join: idle,
      leave: idle,
      buyDrone: idle,
    })
    const { unmount } = renderWithProviders(<CreateLobbyModal />)
    try {
      fireEvent.change(screen.getByLabelText(/operation name/i), { target: { value: 'Orbital Watch' } })

      // The button says what the press will do, and the press is not a spend.
      const signIn = screen.getByRole('button', { name: /sign in to launch/i })
      fireEvent.pointerDown(signIn, { button: 0 })
      expect(screen.queryByText(/hold to launch/i)).not.toBeInTheDocument()
      fireEvent.pointerUp(signIn)
      await act(async () => void fireEvent.click(signIn))

      // Signed in, with everything the creator configured still on screen —
      // and nothing launched.
      expect(run).not.toHaveBeenCalled()
      expect(screen.getByLabelText(/operation name/i)).toHaveValue('Orbital Watch')

      const launch = screen.getByRole('button', { name: /launch operation/i })
      fireEvent.pointerDown(launch, { button: 0 })
      expect(screen.getByText(/hold to launch/i)).toBeInTheDocument()
      expect(run).not.toHaveBeenCalled()
    } finally {
      unmount()
      spy.mockRestore()
    }
  })

  /*
   * Confirming is a wait on the wallet, not on this dialog. Cancel (and the
   * ×) would dismiss the form while a prompt is still sitting behind it.
   */
  it('locks Cancel and Close while the launch is confirming', () => {
    const idle = { status: 'idle' as const, error: null, run: vi.fn() }
    const spy = vi.spyOn(lobbyActions, 'useLobbyActions').mockReturnValue({
      create: { status: 'pending', error: null, run: vi.fn(async () => null) },
      join: idle,
      leave: idle,
      buyDrone: idle,
    })
    const { unmount } = renderWithProviders(<CreateLobbyModal />)
    try {
      expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
      expect(screen.getByRole('button', { name: /confirming/i })).toBeDisabled()
    } finally {
      unmount()
      spy.mockRestore()
    }
  })

  it('asks for a name, and stays quiet about it until the creator engages', () => {
    renderWithProviders(<CreateLobbyModal />)

    const name = screen.getByLabelText(/operation name/i)
    expect(name).toHaveValue('')
    expect(descriptionOf(name)).not.toHaveTextContent(/give the operation a name/i)

    // Typed, then cleared — now the field has something to complain about.
    fireEvent.change(name, { target: { value: 'Orbital Watch' } })
    fireEvent.change(name, { target: { value: '' } })
    expect(descriptionOf(name)).toHaveTextContent(/give the operation a name/i)
  })

  it('blocks submission while the operation has no name', () => {
    renderSignedIn()

    fireEvent.click(screen.getByRole('button', { name: /launch operation/i }))

    expect(screen.getByText(/fix the highlighted field/i)).toBeInTheDocument()
    expect(descriptionOf(screen.getByLabelText(/operation name/i))).toHaveTextContent(/give the operation a name/i)
  })

  it('blocks submission while a value is out of range', () => {
    renderSignedIn()

    fireEvent.change(screen.getByLabelText(/operation name/i), { target: { value: 'Orbital Watch' } })
    fireEvent.change(amountFor(/^entry$/i), { target: { value: String(limits.maxEntryPrice + 1) } })
    fireEvent.click(screen.getByRole('button', { name: /launch operation/i }))

    expect(screen.getByText(/fix the highlighted field/i)).toBeInTheDocument()
  })

  /*
   * The validator takes a config *and a moment*, and only one of them is on
   * the screen.
   *
   * A creator who sets a short application window — the deadline is theirs
   * to choose, and the protocol's minimum is zero — holds a config that
   * expires while they are still reading the summary. The form used to
   * memoise its validation on the config alone, so it kept reporting the
   * answer from when the field was last edited: Launch re-checked against
   * the real clock, found the deadline in the past, and returned without
   * rendering anything. No error, no sign-in, no transaction — the press
   * did nothing at all, which is the one outcome a creator cannot act on.
   */
  it('reports a deadline that expired while the form sat open, rather than refusing in silence', () => {
    vi.useFakeTimers()
    try {
      renderSignedIn()

      fireEvent.change(screen.getByLabelText(/operation name/i), { target: { value: 'test operation' } })
      const deadline = screen.getByLabelText(/application deadline/i)
      fireEvent.change(deadline, { target: { value: toLocalDatetimeValue(Date.now() + 2 * 60_000) } })

      // Legal at the moment it was set, and nothing on the screen says otherwise.
      expect(descriptionOf(deadline)).toHaveTextContent('When applications for this operation close')

      act(() => void vi.advanceTimersByTime(3 * 60_000))

      // The clock alone made it illegal, and the control says so unprompted.
      expect(descriptionOf(deadline)).toHaveTextContent('Application deadline must be in the future.')

      fireEvent.click(screen.getByRole('button', { name: /launch operation/i }))
      expect(screen.getByText(/fix the highlighted field/i)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  /*
   * ТЗ §11 — a short read-back, not the invoice it replaces.
   *
   * The old preview restated every parameter the form was already showing,
   * plus a fee breakdown, immediately underneath it. What survives is the
   * one figure that appears nowhere on the form — what launching actually
   * costs, which is the start pool *plus* the protocol's creation fee, and
   * whose absence used to leave the only row labelled like a total short by
   * exactly that fee, with the difference first appearing in the wallet.
   */
  it('summarises the launch without restating the whole form', () => {
    renderWithProviders(<CreateLobbyModal />)

    const summary = screen.getByRole('region', { name: 'Launch summary' })
    for (const label of ['Launch cost', 'Players', 'Entry', 'Deadline']) {
      expect(within(summary).getByText(label)).toBeInTheDocument()
    }

    const { minStartPrizePool, joinFee } = limits
    expect(within(summary).getByText(formatEth(minStartPrizePool + joinFee))).toBeInTheDocument()

    // The parameters the form is already showing are not repeated here.
    expect(within(summary).queryByText(/creator/i)).not.toBeInTheDocument()
    expect(within(summary).queryByText(/recon/i)).not.toBeInTheDocument()
    expect(within(summary).queryByText(/protocol fee/i)).not.toBeInTheDocument()
  })
})
