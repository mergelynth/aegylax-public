import { describe, expect, it } from 'vitest'
import { protocolLine, resolveProtocolVersion } from '../../../../tools/protocol-version.mjs'

describe('protocol version', () => {
  it('keeps an explicit pin, for builds that must not consult git', () => {
    expect(resolveProtocolVersion({ env: { VITE_PROTOCOL_VERSION: ' 0.2.9 ' }, commitCount: 12 })).toBe('0.2.9')
  })

  it('stamps the git commit count onto the package.json line', () => {
    expect(resolveProtocolVersion({ env: {}, pkgVersion: '0.1.0', commitCount: 40 })).toBe('0.1.40')
    expect(resolveProtocolVersion({ env: {}, pkgVersion: '1.0.0', commitCount: 12 })).toBe('1.0.12')
  })

  /*
   * The shallow-clone case, which shipped a wrong number before it was
   * caught: Vercel clones shallow, `git rev-list --count` answered 10 for
   * the 121st commit, and the live site's build number went *backwards*
   * from 0.1.112. No error anywhere — the build log printed `[version]
   * 0.1.10` as though that were the answer.
   */
  it('names the commit rather than guessing a position when the count is untrustworthy', () => {
    expect(resolveProtocolVersion({ env: {}, pkgVersion: '0.1.0', commitCount: null, commitSha: 'cafcc21' })).toBe(
      '0.1+cafcc21',
    )
    // `+` metadata, not a third number: nothing invites comparing it with
    // the deploy before.
    expect(
      resolveProtocolVersion({ env: {}, pkgVersion: '0.1.0', commitCount: null, commitSha: 'cafcc21' }),
    ).not.toMatch(/^0\.1\.\d/)
  })

  it('falls back to package.json when there is no git at all', () => {
    expect(resolveProtocolVersion({ env: {}, pkgVersion: '0.1.0', commitCount: null, commitSha: null })).toBe('0.1.0')
  })

  it('still prefers a real count over the sha', () => {
    expect(resolveProtocolVersion({ env: {}, pkgVersion: '0.1.0', commitCount: 121, commitSha: 'cafcc21' })).toBe(
      '0.1.121',
    )
  })

  it('reads major and minor from the package line', () => {
    expect(protocolLine('0.1.0')).toEqual({ major: '0', minor: '1' })
    expect(protocolLine('1.2.0')).toEqual({ major: '1', minor: '2' })
  })
})
