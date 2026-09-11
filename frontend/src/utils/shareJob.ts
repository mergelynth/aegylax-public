/**
 * One in-flight promise per key, joined rather than restarted.
 *
 * The map is populated *before* `start` runs, so a second caller arriving
 * in the same tick — a click overlapping an effect, a StrictMode remount —
 * waits for the first rather than kicking off a duplicate. Without that,
 * two `unlockRound` transactions would sit in the wallet at once.
 */
export function shareJob<T>(
  jobs: Map<string, Promise<T>>,
  key: string,
  start: () => Promise<T>,
): Promise<T> {
  const existing = jobs.get(key)
  if (existing) return existing

  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const job = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  jobs.set(key, job)

  try {
    start().then(resolve, reject)
  } catch (err) {
    reject(err)
  }

  const clear = () => {
    if (jobs.get(key) === job) jobs.delete(key)
  }
  /*
   * Both branches settle this derived promise successfully, so cleanup
   * cannot surface as an unhandled rejection — `job.finally(...)` would
   * re-reject, and a `void` on that is what logged "the confidential
   * network is slow to answer" after the Operation screen had already
   * caught `job`. Attached here, before return, so the slot is empty
   * in the same flush the caller awaits.
   */
  void job.then(clear, clear)

  return job
}
