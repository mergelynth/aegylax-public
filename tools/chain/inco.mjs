/**
 * Which Inco release a build compiles against.
 *
 * Inco publishes one executor per "pepper" — mainnet, testnet, devnet — and
 * each is a different address linked into the Solidity library at compile
 * time, paired with its own covalidator quorum that the client SDK resolves
 * from the same pepper name. Getting the two out of step produces handles
 * nothing can decrypt, and does so silently.
 *
 * So the pepper is deployment configuration, exactly like an RPC URL: the
 * engine imports `@inco-active/Lib.sol`, and this writes the remapping that
 * decides what that resolves to before anything is compiled. Changing
 * networks stays an .env change.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTRACTS_DIR, log } from './lib.mjs'

const REMAPPINGS = join(CONTRACTS_DIR, 'remappings.txt')
const KEY = '@inco-active/Lib.sol='

export const KNOWN_PEPPERS = ['mainnet', 'testnet', 'devnet', 'demonet', 'alphanet']

export function incoLibPath(pepper) {
  if (!KNOWN_PEPPERS.includes(pepper)) {
    throw new Error(`Unknown INCO_PEPPER "${pepper}". Expected one of: ${KNOWN_PEPPERS.join(', ')}`)
  }
  return `node_modules/@inco/lightning/src/Lib.${pepper}.sol`
}

/**
 * Points the build at `pepper`'s library, and reports whether that changed
 * anything — a changed remapping means the artifacts on disk were compiled
 * against a different Inco release and must not be reused.
 */
export function selectIncoLib(pepper) {
  const target = `${KEY}${incoLibPath(pepper)}`
  const lines = readFileSync(REMAPPINGS, 'utf8').split('\n')
  const index = lines.findIndex((line) => line.startsWith(KEY))
  const previous = index === -1 ? null : lines[index]

  if (previous === target) return { changed: false, pepper }

  if (index === -1) lines.push(target)
  else lines[index] = target

  writeFileSync(REMAPPINGS, `${lines.filter((line, i) => line !== '' || i < lines.length - 1).join('\n')}\n`.replace(/\n+$/, '\n'))
  log('inco', `compiling against the "${pepper}" release (${incoLibPath(pepper)})`)
  return { changed: true, pepper, previous }
}
