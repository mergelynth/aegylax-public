import { Module } from '@nestjs/common'
import { IndexerController, LobbyDirectoryController } from './indexer.controller'
import { IndexerService } from './indexer.service'

@Module({
  controllers: [IndexerController, LobbyDirectoryController],
  providers: [IndexerService],
  // Exported for `/health`, which reports how far the fold has read. Nothing
  // else drives it: the reader owns its own clock and its own cursor.
  exports: [IndexerService],
})
export class IndexerModule {}
