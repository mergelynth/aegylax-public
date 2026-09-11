#!/usr/bin/env node
/**
 * Runs before every frontend build (ТЗ §14).
 *
 * Its whole job is to make "the UI is built against whatever is deployed"
 * automatic: if there are deployment manifests, the generated contract
 * config is refreshed from them, so a build can never ship an address or an
 * ABI that is a release behind. If there are none — a fresh clone, or a
 * frontend running in emulator mode — it says so and gets out of the way,
 * because a missing deployment is a perfectly ordinary state and not a
 * build failure.
 */

import { syncFrontend, listDeployedChains } from './sync-frontend.mjs'
import { loadEnv, log, warn } from './lib.mjs'
import { resolveProtocolVersion } from '../protocol-version.mjs'

/*
 * A production build that quietly ships the emulator is the failure this
 * check exists for.
 *
 * The emulator is a development tool: it settles the game in the browser,
 * accepts every call from the tab it runs in, and hands out an identity
 * nobody had to sign in for. None of that is visible from the built output —
 * it looks like the real app, with "Local emulator" in a status popover
 * somebody has to open — so a stale `.env` at build time is enough to
 * publish a site where anything can be done without a wallet. This makes it
 * loud, without failing the build, because building the emulator on purpose
 * is a legitimate thing to do.
 */
const env = loadEnv()
log('version', resolveProtocolVersion())
if ((env.VITE_BLOCKCHAIN_MODE ?? '').trim() !== 'contract') {
  warn(
    'VITE_BLOCKCHAIN_MODE is not "contract" — this build will ship the in-memory ' +
      'EMULATOR: no chain, no real wallet, and every action available without connecting one. ' +
      'Set VITE_BLOCKCHAIN_MODE=contract in .env for a deployable build.',
  )
}

const chains = listDeployedChains()

if (chains.length === 0) {
  warn('No deployment manifests in deployments/ — building with the generated config as it stands.')
  process.exit(0)
}

log('prebuild', `refreshing contract config for chain(s) ${chains.join(', ')}`)
try {
  syncFrontend()
} catch (error) {
  // A stale artifact directory should not block a UI build; the generated
  // files already in the tree stay usable.
  warn(`Could not regenerate contract config: ${error.message}`)
}
