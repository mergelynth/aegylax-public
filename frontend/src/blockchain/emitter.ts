/**
 * Small synchronous pub/sub used by `BlockchainClient` implementations for
 * both game-event and block-number push channels. Callbacks fire
 * synchronously, in subscription order, on the same tick as `emit` — there
 * is no batching/async scheduling here, matching the emulator's
 * no-background-scheduler rule (spec §58): the emitter only ever fires in
 * direct response to something the client itself did (mined a block,
 * confirmed a write).
 */
export class EventEmitter<TKey, TPayload> {
  private readonly listeners = new Map<TKey, Set<(payload: TPayload) => void>>()

  on(key: TKey, callback: (payload: TPayload) => void): () => void {
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(callback)
    return () => set?.delete(callback)
  }

  emit(key: TKey, payload: TPayload): void {
    for (const callback of this.listeners.get(key) ?? []) callback(payload)
  }
}
