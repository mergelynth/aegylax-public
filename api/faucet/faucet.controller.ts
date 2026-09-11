import { Body, Controller, HttpStatus, Logger, Post, Res } from '@nestjs/common'
import type { Response } from 'express'
import { FaucetService } from './faucet.service'

/**
 * One route, one shape: `{ "address": "0x…" }` in, a drip or a reason out.
 *
 * Statuses are set explicitly rather than thrown as exceptions because every
 * refusal here is an ordinary answer the page renders — too soon, empty, not
 * configured — and a 429 carries `retryAtMs`, which is the only thing that
 * lets the panel say *when* instead of just "no".
 */
@Controller('api/faucet')
export class FaucetController {
  private readonly logger = new Logger(FaucetController.name)

  constructor(private readonly faucet: FaucetService) {}

  @Post()
  async drip(@Body() body: unknown, @Res() res: Response) {
    const address = (body as { address?: unknown })?.address
    if (typeof address !== 'string') {
      return res.status(HttpStatus.BAD_REQUEST).json({ ok: false, error: 'Body must be {"address": "0x…"}.' })
    }

    try {
      const { status, body: payload } = await this.faucet.drip(address)
      return res.status(status).json(payload)
    } catch (error) {
      // The caller learns nothing about which variable or service failed:
      // that is a map of the deployment for anybody probing it.
      this.logger.error(`request failed: ${String((error as Error)?.message ?? error)}`)
      return res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ ok: false, error: 'Could not send the top-up. Try again in a minute.' })
    }
  }
}
