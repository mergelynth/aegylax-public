import { describe, expect, it } from 'vitest'
import { shareJob } from '../../utils/shareJob'

describe('shareJob', () => {
  it('runs the work once and lets a second caller wait for it', async () => {
    const jobs = new Map<string, Promise<number>>()
    let started = 0
    let release!: (value: number) => void
    const start = () => {
      started += 1
      return new Promise<number>((resolve) => {
        release = resolve
      })
    }

    const first = shareJob(jobs, 'reveal', start)
    const second = shareJob(jobs, 'reveal', start)
    expect(started).toBe(1)

    release(7)
    await expect(first).resolves.toBe(7)
    await expect(second).resolves.toBe(7)
  })

  it('starts fresh work after the previous job has settled', async () => {
    const jobs = new Map<string, Promise<number>>()
    let started = 0
    const start = () => Promise.resolve(++started)

    await shareJob(jobs, 'reveal', start)
    await shareJob(jobs, 'reveal', start)
    expect(started).toBe(2)
  })

  it('clears the slot after a rejection so the next call is new work', async () => {
    const jobs = new Map<string, Promise<number>>()
    let started = 0
    const start = () => {
      started += 1
      return Promise.reject(new Error('kms down'))
    }

    await expect(shareJob(jobs, 'reveal', start)).rejects.toThrow('kms down')
    await expect(shareJob(jobs, 'reveal', start)).rejects.toThrow('kms down')
    expect(started).toBe(2)
  })

  it('does not turn a caller-handled rejection into an unhandled one', async () => {
    const jobs = new Map<string, Promise<number>>()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(shareJob(jobs, 'reveal', () => Promise.reject(new Error('kms down')))).rejects.toThrow(
        'kms down',
      )
      await Promise.resolve()
      await Promise.resolve()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
