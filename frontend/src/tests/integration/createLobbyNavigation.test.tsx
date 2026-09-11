import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '../../app/App'

describe('integration: Create Operation UI flow navigates to /lobby/:txHash (spec §13-16)', () => {
  it('creates an operation through the modal and lands on the operation screen with a matching id', async () => {
    render(<App />)

    /*
     * Connecting first, because creating an operation is a write and a write
     * needs somebody to make it. The local identity exists in the browser
     * from the first render, but it does not reach the app until the player
     * has actually connected — so this click is the whole difference between
     * a visitor and a creator, and skipping it is what the flow now refuses.
     */
    fireEvent.click(await screen.findByRole('button', { name: /connect wallet|sign in/i }))

    fireEvent.click(screen.getByRole('button', { name: /^create operation$/i }))
    const dialog = await screen.findByRole('dialog', { name: 'Create Operation' })
    // The name is required, so nothing launches until it is filled in.
    fireEvent.change(within(dialog).getByLabelText('Operation name'), { target: { value: 'Orbital Watch' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^launch operation$/i }))

    const heading = await waitFor(() => screen.getByText(/^Operation 0x/), { timeout: 3000 })
    expect(heading.textContent).toMatch(/^Operation 0x[0-9a-f]{4}…[0-9a-f]{4}$/)
    // The creator's name is what the operation is called on its own screen.
    expect(screen.getByRole('heading', { name: 'Orbital Watch' })).toBeInTheDocument()

    // Applications are still open, so there is nothing to command yet and
    // mission control stays off the scene — it would be a panel of dashes.
    expect(screen.queryByRole('region', { name: 'Command Center' })).not.toBeInTheDocument()
  })
})
