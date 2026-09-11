import { Module } from '@nestjs/common'
import { ChainModule } from './chain/chain.module'
import { FaucetModule } from './faucet/faucet.module'
import { HealthModule } from './health/health.module'
import { IndexerModule } from './indexer/indexer.module'
import { KeeperModule } from './keeper/keeper.module'

/**
 * Three features and a health check, over one shared chain.
 *
 * The shape was the point rather than the size, and `indexer/` is the module
 * it was laid out for: it wants exactly what `ChainModule` already exports,
 * so it arrived as a folder rather than a refactor. `lobbies/` — search over
 * what the indexer folds — is the next one, on the same terms.
 */
@Module({
  imports: [ChainModule, FaucetModule, KeeperModule, IndexerModule, HealthModule],
})
export class AppModule {}
