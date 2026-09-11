import { Controller, Get, Header, Inject } from '@nestjs/common'
import { CONFIG, type AppConfig } from '../config/configuration'
import { IndexerService } from '../indexer/indexer.service'
import { KeeperService } from '../keeper/keeper.service'
import { KeepaliveService } from './keepalive.service'

/**
 * Liveness for the host, and the only window an operator has into the
 * background job.
 *
 * It reports addresses and timings, never a key and never anything a public
 * URL should not carry. The keeper's last block and last error are the two
 * facts that distinguish "running with nothing to do" from "wedged", and
 * without them those look identical from outside.
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly keeper: KeeperService,
    private readonly indexer: IndexerService,
    private readonly keepalive: KeepaliveService,
  ) {}

  @Get()
  health() {
    return {
      ok: true,
      chainId: this.config.chain.id,
      network: this.config.chain.network,
      contract: this.config.chain.contract,
      faucet: {
        enabled: this.config.faucet.enabled && Boolean(this.config.faucet.privateKey),
        address: this.config.faucet.address,
      },
      keeper: {
        enabled: this.config.keeper.enabled && Boolean(this.config.keeper.privateKey),
        address: this.config.keeper.address,
        reveal: this.config.keeper.reveal,
        ...this.keeper.state,
      },
      /*
       * How far the fold has read, which is the difference between a wallet
       * with no history and a history nobody has reached yet — the same
       * distinction `/api/players` reports, and the only one that makes a
       * quiet indexer distinguishable from a wedged one.
       */
      indexer: {
        enabled: this.config.indexer.enabled,
        fromBlock: Number(this.config.indexer.fromBlock),
        ...this.indexer.state,
      },
      /*
       * Whether the thing keeping this host awake is itself awake. An
       * uptime that keeps resetting between two reads means the pings are
       * not landing often enough; a `pings` of zero means they are not
       * landing at all, whatever the cron's own dashboard says.
       */
      keepalive: this.keepalive.state,
    }
  }

  /**
   * The route to point a cron at, and deliberately the cheapest one here.
   *
   * `/health` reaches into the keeper and the indexer to build its answer,
   * and a host's own health check already calls it on its own schedule.
   * Something hitting a URL every few minutes forever should not pay for
   * that, and should not be able to make a wedged indexer look like a dead
   * server: this touches nothing, can fail for no reason, and exists only so
   * that a request arrives.
   *
   * `no-store` because the request is the entire point. Anything that
   * answers it on the way — a proxy, a CDN, an uptime service's own cache —
   * leaves the process asleep behind a cheerful 200.
   */
  @Get('ping')
  @Header('Cache-Control', 'no-store')
  ping() {
    return { ok: true, ...this.keepalive.ping() }
  }
}
