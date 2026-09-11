import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { JackpotHud } from '../../components/stats/JackpotHud'
import { useGlobalDefenseDraw, type GlobalDefenseHudState } from '../../hooks/useGlobalDefenseDraw'
import { renderWithProviders } from '../testUtils'

vi.mock('../../hooks/useGlobalDefenseDraw', () => ({
  useGlobalDefenseDraw: vi.fn(),
}))

const idle: GlobalDefenseHudState = {
  pool: 0,
  jackpot: 0,
  lobbyId: null,
  joinable: false,
  inPlay: false,
  nextEpoch: 1000,
  interval: 1000,
  openFromBlock: null,
  deadlineBlock: null,
  ready: false,
  drawLobbyId: null,
  drawLobby: null,
}

const mockedDraw = vi.mocked(useGlobalDefenseDraw)

describe('<JackpotHud />', () => {
  it('shows a loader instead of 0 while the pool is still in flight', () => {
    mockedDraw.mockReturnValue({ ...idle, ready: false, jackpot: 0 })
    renderWithProviders(<JackpotHud />)
    expect(screen.getByLabelText(/jackpot loading/i)).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByText(/^0$/)).not.toBeInTheDocument()
  })

  it('paints the figure once the draw has landed', () => {
    mockedDraw.mockReturnValue({ ...idle, ready: true, jackpot: 0.023 })
    renderWithProviders(<JackpotHud />)
    expect(screen.getByLabelText(/jackpot: 0\.023/i)).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByText('0.023')).toBeInTheDocument()
  })

  it('hides the trophy when the jackpot is empty', () => {
    mockedDraw.mockReturnValue({ ...idle, ready: true, jackpot: 0 })
    renderWithProviders(<JackpotHud />)
    expect(screen.queryByLabelText(/jackpot/i)).not.toBeInTheDocument()
  })

  it('rounds the prize to three decimal places', () => {
    mockedDraw.mockReturnValue({ ...idle, ready: true, jackpot: 0.02301 })
    renderWithProviders(<JackpotHud />)
    expect(screen.getByText('0.023')).toBeInTheDocument()
    expect(screen.queryByText('0.02301')).not.toBeInTheDocument()
  })

  it('pins the tooltip on a tap so a phone can read it', () => {
    mockedDraw.mockReturnValue({ ...idle, ready: true, jackpot: 0.5, nextEpoch: 1000 })
    renderWithProviders(<JackpotHud />)
    const trophy = screen.getByLabelText(/jackpot: 0\.5/i)
    expect(trophy).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trophy)
    expect(trophy).toHaveAttribute('aria-expanded', 'true')
  })
})
