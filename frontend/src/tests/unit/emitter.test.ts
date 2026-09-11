import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from '../../blockchain/emitter'

describe('EventEmitter', () => {
  it('delivers emitted payloads only to listeners on the matching key', () => {
    const emitter = new EventEmitter<string, number>()
    const onA = vi.fn()
    const onB = vi.fn()
    emitter.on('a', onA)
    emitter.on('b', onB)

    emitter.emit('a', 1)

    expect(onA).toHaveBeenCalledWith(1)
    expect(onB).not.toHaveBeenCalled()
  })

  it('supports multiple listeners on the same key', () => {
    const emitter = new EventEmitter<string, number>()
    const first = vi.fn()
    const second = vi.fn()
    emitter.on('a', first)
    emitter.on('a', second)

    emitter.emit('a', 42)

    expect(first).toHaveBeenCalledWith(42)
    expect(second).toHaveBeenCalledWith(42)
  })

  it('stops delivering to a listener once unsubscribed', () => {
    const emitter = new EventEmitter<string, number>()
    const callback = vi.fn()
    const unsubscribe = emitter.on('a', callback)

    unsubscribe()
    emitter.emit('a', 1)

    expect(callback).not.toHaveBeenCalled()
  })

  it('is a no-op emitting to a key with no listeners', () => {
    const emitter = new EventEmitter<string, number>()
    expect(() => emitter.emit('missing', 1)).not.toThrow()
  })
})
