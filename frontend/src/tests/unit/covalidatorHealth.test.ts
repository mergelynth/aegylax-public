import { describe, expect, it, vi } from 'vitest'
import {
  covalidatorUrlsOf,
  pingCovalidatorIsReady,
  probeCovalidatorQuorum,
} from '../../blockchain/contract/confidential'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('covalidatorUrlsOf', () => {
  it('keeps the SDK instance list and drops empties', () => {
    expect(
      covalidatorUrlsOf({
        covalidatorUrls: ['https://a.inco.org', '', 'https://b.inco.org'],
      }),
    ).toEqual(['https://a.inco.org', 'https://b.inco.org'])
  })

  it('returns nothing when the instance has not resolved a quorum', () => {
    expect(covalidatorUrlsOf({})).toEqual([])
  })
})

describe('pingCovalidatorIsReady', () => {
  it('posts Connect JSON to IsReady and treats ready:true as up', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ready: true }))
    await expect(pingCovalidatorIsReady('https://node.inco.org/', fetchImpl)).resolves.toEqual({
      ready: true,
      lagSeconds: null,
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://node.inco.org/inco.kms.lite.v1.KmsService/IsReady',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
      }),
    )
  })

  it('treats ready:false, HTTP 500, and a thrown fetch as down', async () => {
    await expect(
      pingCovalidatorIsReady('https://node.inco.org', vi.fn().mockResolvedValue(jsonResponse({ ready: false }))),
    ).resolves.toEqual({ ready: false, lagSeconds: null })
    await expect(
      pingCovalidatorIsReady(
        'https://node.inco.org',
        vi.fn().mockResolvedValue(jsonResponse({ error: 'internal' }, 500)),
      ),
    ).resolves.toEqual({ ready: false, lagSeconds: null })
    await expect(
      pingCovalidatorIsReady('https://node.inco.org', vi.fn().mockRejectedValue(new Error('fetch failed'))),
    ).resolves.toEqual({ ready: false, lagSeconds: null })
  })

  it('reads indexer lag out of a Connect 500 body', async () => {
    await expect(
      pingCovalidatorIsReady(
        'https://node.inco.org',
        vi.fn().mockResolvedValue(
          jsonResponse(
            {
              code: 'unknown',
              message: 'rpc error: code = Internal desc = failed to check acl; out of sync: 1725 seconds behind',
            },
            500,
          ),
        ),
      ),
    ).resolves.toEqual({ ready: false, lagSeconds: 1725 })
  })
})

describe('probeCovalidatorQuorum', () => {
  it('is up when any node answers ready', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({ ready: true }))
    await expect(
      probeCovalidatorQuorum(['https://a.inco.org', 'https://b.inco.org'], fetchImpl),
    ).resolves.toEqual({ ready: true, lagSeconds: null })
  })

  it('is down when every node misses, or when there is no quorum to ask', async () => {
    await expect(probeCovalidatorQuorum([])).resolves.toEqual({ ready: false, lagSeconds: null })
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500))
    await expect(probeCovalidatorQuorum(['https://a.inco.org'], fetchImpl)).resolves.toEqual({
      ready: false,
      lagSeconds: null,
    })
  })

  it('publishes the worst indexer lag even if another node answers ready', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ready: true }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: 'unknown',
            message: 'rpc error: code = Internal desc = failed to check acl; out of sync: 90 seconds behind',
          },
          500,
        ),
      )
    await expect(
      probeCovalidatorQuorum(['https://a.inco.org', 'https://b.inco.org'], fetchImpl),
    ).resolves.toEqual({ ready: false, lagSeconds: 90 })
  })
})
