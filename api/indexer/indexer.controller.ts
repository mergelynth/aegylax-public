import { Controller, Get, HttpStatus, Param, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { isAddress } from 'viem'
import { IndexerService } from './indexer.service'
import type { LobbyStatus } from './lobbies'

/**
 * One route: what this wallet has done, from the protocol's own log.
 *
 * A wallet with no history is a 200 with zeroes, not a 404. "Never played"
 * is a real answer to the question, the panel has to render something for it
 * either way, and a 404 would make an empty record indistinguishable from a
 * backend that is not there.
 *
 * The address is public information and the answer is derived from public
 * events, so there is nothing here to authenticate — anybody could fold the
 * same logs themselves, and this only saves them the requests.
 */
@Controller('api/players')
export class IndexerController {
  constructor(private readonly indexer: IndexerService) {}

  @Get(':address')
  record(@Param('address') address: string, @Res() res: Response) {
    if (!isAddress(address)) {
      return res.status(HttpStatus.BAD_REQUEST).json({ ok: false, error: 'Not an address.' })
    }
    if (!this.indexer.enabled) {
      return res
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ ok: false, error: 'This deployment does not keep player records.' })
    }

    const { record, indexedThroughBlock, syncing } = this.indexer.recordFor(address)
    return res
      .status(HttpStatus.OK)
      .json({ ok: true, contract: this.indexer.contract, record, indexedThroughBlock, syncing })
  }

  /**
   * The operations this wallet is in — the live ones first, then what is
   * behind it.
   *
   * Its own route rather than another field on the record, because the two
   * answer different questions and are read at different moments: the record
   * is four figures a panel always shows, and this is a list somebody follows
   * a link out of. Bolting it onto the record would make every panel-open
   * carry a list most of them never render.
   */
  @Get(':address/lobbies')
  playerLobbies(@Param('address') address: string, @Res() res: Response) {
    if (!isAddress(address)) {
      return res.status(HttpStatus.BAD_REQUEST).json({ ok: false, error: 'Not an address.' })
    }
    if (!this.indexer.enabled) {
      return res
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ ok: false, error: 'This deployment does not keep player records.' })
    }
    return res
      .status(HttpStatus.OK)
      .json({ ok: true, contract: this.indexer.contract, ...this.indexer.lobbiesFor(address) })
  }
}

/**
 * The directory: every operation the protocol has opened, newest first.
 *
 * Separate from `api/players` because it is about the game rather than about
 * one wallet, and it is the route that makes an operation findable at all —
 * before it existed the only ways in were creating one or being sent a link.
 */
@Controller('api/lobbies')
export class LobbyDirectoryController {
  constructor(private readonly indexer: IndexerService) {}

  @Get()
  list(
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Query('q') query: string | undefined,
    @Res() res: Response,
  ) {
    if (!this.indexer.enabled) {
      return res
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ ok: false, error: 'This deployment does not keep an operation directory.' })
    }

    const statuses: LobbyStatus[] = ['open', 'active', 'finished', 'cancelled']
    // An unknown filter is a 400 rather than silently everything: a page
    // asking for a status this build does not have is a bug in the page, and
    // answering it with the full list hides that behind plausible output.
    if (status !== undefined && !statuses.includes(status as LobbyStatus)) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ ok: false, error: `status must be one of ${statuses.join(', ')}.` })
    }

    return res.status(HttpStatus.OK).json({
      ok: true,
      // Which deployment these rooms are from. A client built against a
      // different one drops the answer rather than showing another
      // protocol's history as its own.
      contract: this.indexer.contract,
      ...this.indexer.lobbies({
        status: status as LobbyStatus | undefined,
        limit: limit === undefined ? undefined : Number(limit),
        offset: offset === undefined ? undefined : Number(offset),
        // Trimmed to something a name could be. A 2KB query string is not a
        // search for an operation, and matching it would walk every lobby.
        query: query === undefined ? undefined : query.slice(0, 64),
      }),
    })
  }
}
