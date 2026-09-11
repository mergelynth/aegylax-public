#!/usr/bin/env node
/**
 * Protocol version shown in the status popover.
 *
 * SemVer, with the usual meaning of a leading zero: the protocol is not
 * frozen. `package.json` holds the *line* (`MAJOR.MINOR.0`). The build
 * number is how many commits are on HEAD, so every push to GitHub that
 * Vercel (or `vite build`) actually ships is a new patch:
 *
 *   0.1.40   testnet, minor line 1, 40th commit
 *   1.0.412  mainnet line — bump package.json to 1.0.0 when that ships
 *
 * Override with `VITE_PROTOCOL_VERSION` when a build must pin a number
 * (reproducible CI, a screenshot). Do not bump package.json on every push.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function protocolLine(pkgVersion) {
  const [major = '0', minor = '1'] = String(pkgVersion).split('.')
  return { major, minor }
}

export function gitCommitCount(cwd = ROOT, env = process.env) {
  const run = (command, extra = {}) =>
    execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...extra }).trim()

  try {
    const shallow = run('git rev-parse --is-shallow-repository') === 'true'
    // Vercel clones shallow. One unshallow makes the count real; skip it
    // in tests and on a full local checkout so `vite` stays offline.
    if (shallow && env.VERCEL === '1') {
      try {
        execSync('git fetch --unshallow --quiet', { cwd, stdio: 'ignore' })
      } catch {
        try {
          execSync('git fetch --deepen=10000 --quiet', { cwd, stdio: 'ignore' })
        } catch {
          // Deliberately nothing: whether either fetch worked is decided
          // below by asking git again, not by whether it threw.
        }
      }
    }

    /*
     * Counted only if the history is actually all here.
     *
     * A count taken from a shallow clone is not an imprecise version, it is
     * a wrong one — and wrong in the direction that does the most damage. A
     * deploy printed `0.1.10` where the commit was the 121st, so the number
     * on the live site went *backwards* from the 0.1.112 before it, which
     * is the one thing a build number must never do. Nothing failed, and
     * the log said `[version] 0.1.10` as if that were the answer.
     *
     * `null` sends the caller to the commit sha instead, which cannot be
     * mistaken for a position in a sequence.
     */
    if (run('git rev-parse --is-shallow-repository') === 'true') return null

    const raw = run('git rev-list --count HEAD')
    const count = Number(raw)
    if (Number.isInteger(count) && count > 0) return count
  } catch {
    // No git, or not a repo — the caller falls back to package.json.
  }
  return null
}

/**
 * The commit itself, for a build that cannot count.
 *
 * Vercel exports the sha, so this answers even where the clone is too
 * shallow for git to. Seven characters: enough to find the commit, short
 * enough to sit in a status row.
 */
export function gitCommitSha(cwd = ROOT, env = process.env) {
  const fromPlatform = env.VERCEL_GIT_COMMIT_SHA?.trim()
  if (fromPlatform) return fromPlatform.slice(0, 7)
  try {
    const sha = execSync('git rev-parse --short=7 HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return sha || null
  } catch {
    return null
  }
}

export function resolveProtocolVersion({
  env = process.env,
  pkgVersion,
  commitCount,
  commitSha,
} = {}) {
  const pinned = env.VITE_PROTOCOL_VERSION?.trim()
  if (pinned) return pinned

  const pkg =
    pkgVersion ??
    JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const { major, minor } = protocolLine(pkg)
  const build = commitCount === undefined ? gitCommitCount(ROOT, env) : commitCount
  if (build !== null) return `${major}.${minor}.${build}`

  /*
   * No trustworthy count. `+sha` rather than a third number: it identifies
   * the build exactly and reads as metadata rather than as an ordinal, so
   * nobody compares it with the deploy before.
   */
  const sha = commitSha === undefined ? gitCommitSha(ROOT, env) : commitSha
  if (sha) return `${major}.${minor}+${sha}`
  return pkg
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  process.stdout.write(`${resolveProtocolVersion()}\n`)
}
