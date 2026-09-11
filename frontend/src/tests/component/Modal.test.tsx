import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Modal } from '../../components/common/Modal'

const MODAL_CSS = readFileSync(resolve(process.cwd(), 'frontend/src/components/common/Modal.module.css'), 'utf8')

describe('<Modal />', () => {
  it('closes on the close button', () => {
    const onClose = vi.fn()
    render(
      <Modal title="Defense Setup" onClose={onClose}>
        <p>Body</p>
      </Modal>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('refuses the close button while a spend is in flight', () => {
    const onClose = vi.fn()
    render(
      <Modal title="Create Operation" onClose={onClose} closeDisabled>
        <p>Body</p>
      </Modal>,
    )

    const close = screen.getByRole('button', { name: 'Close' })
    expect(close).toBeDisabled()
    fireEvent.click(close)
    expect(onClose).not.toHaveBeenCalled()
  })

  /**
   * A dialog holds work in progress — a half-filled Defense Setup form
   * above all — so a stray click outside it must not discard that work.
   */
  it('ignores clicks on the backdrop', () => {
    const onClose = vi.fn()
    render(
      <Modal title="Defense Setup" onClose={onClose}>
        <p>Body</p>
      </Modal>,
    )

    const dialog = screen.getByRole('dialog', { name: 'Defense Setup' })
    const backdrop = dialog.parentElement
    if (!backdrop) throw new Error('Dialog is not wrapped in a backdrop')

    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not close when a click inside bubbles out', () => {
    const onClose = vi.fn()
    render(
      <Modal title="Defense Setup" onClose={onClose}>
        <p>Body</p>
      </Modal>,
    )

    fireEvent.click(screen.getByText('Body'))
    expect(onClose).not.toHaveBeenCalled()
  })

  /**
   * The dialog opens from whatever was pressed — but it must never be
   * *invisible* to do it. An entrance written as `initial={{ opacity: 0 }}`
   * leaves a real transparent element on screen until the first frame runs,
   * which is a state anywhere frames do not run gets stuck in: a test, a
   * print, a crawler. So the panel's own entrance is transform alone, and
   * the scrim's fade is a stylesheet keyframe, which never touches the
   * computed style.
   */
  it('is readable on its first frame, before anything has animated', () => {
    render(
      <Modal title="Defense Setup" onClose={vi.fn()}>
        <p>Body</p>
      </Modal>,
    )

    expect(screen.getByRole('dialog', { name: 'Defense Setup' })).toBeVisible()
    expect(screen.getByText('Body')).toBeVisible()
    expect(MODAL_CSS).toMatch(/@keyframes modal-scrim/)
  })
})
