import { Body, Controller, HttpStatus, Logger, Post, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { KeeperService } from './keeper.service'

/**
 * A press from the page, not a second clock.
 *
 * Unlock and scoring are the keeper wallet's, never the player's. This
 * route is how Reveal asks the sweep to run now instead of waiting for
 * the next interval — and how it does that without opening a wallet.
 */
@Controller('api/keeper')
export class KeeperController {
  private readonly logger = new Logger(KeeperController.name)

  constructor(private readonly keeper: KeeperService) {}

  @Post('reveal')
  async reveal(
    @Res() res: Response,
    @Body() body: { lobbyId?: unknown } | undefined,
    @Query('lobbyId') query?: string,
  ) {
    /*
     * Which operation, if the caller knows.
     *
     * Without it the keeper walks every lobby to answer one page, and may
     * answer from a sweep that had already passed the caller's. Accepted
     * from the body or the query so a curl and the app can both say it, and
     * only in the one shape a lobby id ever has — anything else is dropped
     * rather than handed to an RPC as a bytes32.
     */
    const raw = typeof body?.lobbyId === 'string' ? body.lobbyId : query
    const lobbyId = raw && /^0x[0-9a-fA-F]{64}$/.test(raw) ? raw : undefined

    try {
      const result = await this.keeper.nudge(lobbyId)
      return res.status(result.ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json(result)
    } catch (error) {
      this.logger.error(`nudge failed: ${String((error as Error)?.message ?? error)}`)
      return res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ ok: false, error: 'The keeper could not start the reveal. Try again in a moment.' })
    }
  }
}
