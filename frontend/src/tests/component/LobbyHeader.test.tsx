import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LobbyHeader } from '../../components/lobby/LobbyHeader'
import type { Hash, Lobby } from '../../game/types'
import { buildTestLobbyConfig } from '../fixtures'

const LOBBY_URL = 'http://localhost:3000/lobby/0xabc'

function lobby(): Lobby {
  return {
    id: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' as Hash,
    creationTxHash: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' as Hash,
    creator: '0x1111111111111111111111111111111111111111',
    createdAtBlock: 1,
    status: 'OPEN',
  ending: 'NONE',
    config: buildTestLobbyConfig({ name: 'Orbital Watch' }),
    participantCount: 0,
    participantAddresses: [],
    currentEpochId: null,
    activeAttackId: null,
    outcome: null,
    creatorSettlement: 0,
    creatorSettled: false,
    reveal: null,
  }
}

function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(window, 'location', { value: { href: LOBBY_URL }, writable: true })
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

afterEach(() => vi.restoreAllMocks())

describe('<LobbyHeader /> share', () => {
  it('copies this operation’s URL and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)

    render(<LobbyHeader lobby={lobby()} />)
    await userEvent.click(screen.getByRole('button', { name: /copy link/i }))

    expect(writeText).toHaveBeenCalledWith(LOBBY_URL)
    expect(await screen.findByText('Link copied')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /link copied/i })).toBeInTheDocument()
  })

  /**
   * A copy leaves no trace on screen, so a silent failure — an insecure
   * origin, a refused permission — is indistinguishable from a success.
   * Both outcomes are reported, in the same place.
   */
  it('says so when the clipboard refuses, rather than looking like it worked', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')))

    render(<LobbyHeader lobby={lobby()} />)
    await userEvent.click(screen.getByRole('button', { name: /copy link/i }))

    await waitFor(() => expect(screen.getByText('Copy failed')).toBeInTheDocument())
    expect(screen.queryByText('Link copied')).not.toBeInTheDocument()
  })

  it('leaves the operation’s name and id exactly where they were', () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    render(<LobbyHeader lobby={lobby()} />)

    expect(screen.getByRole('heading', { name: 'Orbital Watch' })).toBeInTheDocument()
    expect(screen.getByText(/^Operation 0x/)).toBeInTheDocument()
  })
})
