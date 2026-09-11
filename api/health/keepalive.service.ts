import { Injectable } from '@nestjs/common'

/**
 * The one fact a keepalive can prove, and the one it is usually asked for.
 *
 * A host that sleeps on inactivity does not sleep because nothing is
 * *happening* — the keeper's timer and the indexer's poll are both running
 * the whole time — it sleeps because nothing is *arriving*. So the cure is
 * an inbound request on a clock, and the route it lands on can do nothing at
 * all and still work.
 *
 * What it cannot do is tell you whether it worked. A ping that answers 200
 * answers 200 just as happily on a process that was cold-started by that
 * very request, which is the exact failure the cron exists to prevent. This
 * holds the two numbers that separate them: `bootedAt`, which stays put on a
 * process that never went down, and a count of how many pings this process
 * has actually seen, which stays at zero when the cron is misconfigured or
 * quietly stopped. Both are in `/health`, so the question "is my keepalive
 * running" has an answer that is not "the last one returned 200".
 */
@Injectable()
export class KeepaliveService {
  /** When this process started answering. Resets on every cold start. */
  readonly bootedAt = Date.now()

  private pings = 0
  private lastPingAt: number | null = null

  get state() {
    return {
      bootedAt: this.bootedAt,
      uptimeSeconds: Math.round((Date.now() - this.bootedAt) / 1000),
      /** Pings this process has answered — zero means the cron is not reaching it. */
      pings: this.pings,
      lastPingAt: this.lastPingAt,
    }
  }

  ping() {
    this.pings += 1
    this.lastPingAt = Date.now()
    return this.state
  }
}
