import { Module } from '@nestjs/common'
import { KeeperController } from './keeper.controller'
import { KeeperService } from './keeper.service'

@Module({
  controllers: [KeeperController],
  providers: [KeeperService],
  // Exported so `/health` can report what the sweep is doing, and so a
  // Reveal press can nudge the same sweep instead of opening a wallet.
  exports: [KeeperService],
})
export class KeeperModule {}
