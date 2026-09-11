import { Global, Module } from '@nestjs/common'
import { CONFIG, loadConfig } from '../config/configuration'
import { ChainService } from './chain.service'

/**
 * Global, because every feature module needs the same chain and the same
 * config, and threading them through imports buys nothing — there is one
 * chain, and a second one would be a different deployment of this service
 * rather than a second provider inside it.
 */
@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: loadConfig }, ChainService],
  exports: [CONFIG, ChainService],
})
export class ChainModule {}
