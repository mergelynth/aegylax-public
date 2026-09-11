import { Module } from '@nestjs/common'
import { IndexerModule } from '../indexer/indexer.module'
import { KeeperModule } from '../keeper/keeper.module'
import { HealthController } from './health.controller'
import { KeepaliveService } from './keepalive.service'

@Module({
  imports: [KeeperModule, IndexerModule],
  controllers: [HealthController],
  providers: [KeepaliveService],
})
export class HealthModule {}
