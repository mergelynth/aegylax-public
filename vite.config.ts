/// <reference types="vitest/config" />
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const protocolVersion = execSync('node ./tools/protocol-version.mjs', { encoding: 'utf8' }).trim()
const repoRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: 'frontend',
  // `.env` lives at the repo root (shared with the API and chain tools).
  envDir: repoRoot,
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  plugins: [react()],
  define: {
    // Every GitHub push that produces a build gets a new patch. See tools/protocol-version.mjs.
    'import.meta.env.VITE_PROTOCOL_VERSION': JSON.stringify(protocolVersion),
  },
  server: {
    // Bind dual-stack so `localhost` works whether the browser resolves it
    // to 127.0.0.1 or ::1 — binding IPv6-only refuses IPv4 connections.
    host: true,
    port: 5173,
    // Occupied port is a leftover `npm run dev`, not a reason to open 5174.
    // A second instance would re-optimize `.vite/deps` under the first
    // browser tab and Sign in would open as a blur with 504.
    strictPort: true,
    fs: { allow: [repoRoot] },
    /*
     * Same-origin `/api` while `npm run api:dev` is up. The page asks the
     * backend for the operation directory; without this, an empty
     * `VITE_API_URL` fetches Vite itself and the list never loads.
     */
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  optimizeDeps: {
    // Privy's login UI is a lazily loaded chunk (`LandingScreen-*.js`).
    // If Vite re-optimizes deps mid-session the browser keeps the old URL
    // and Sign in opens as a blur overlay with `504 (Outdated Optimize Dep)`.
    include: ['@privy-io/react-auth'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [fileURLToPath(new URL('./frontend/src/tests/setupTests.ts', import.meta.url))],
    css: true,
    /*
     * The suite's own environment, pinned.
     *
     * Vitest loads `.env` the same way the dev server does, which quietly
     * made the test results a function of whichever network the developer
     * running them happened to be pointed at: switching `.env` to contract
     * mode failed seven tests that assert on the emulator and on the local
     * identity, in files that had not changed. The suite tests the emulator
     * path deliberately — it is the one that runs without a chain — so it
     * says so here, and a test that wants other values sets them itself.
     */
    env: {
      VITE_BLOCKCHAIN_MODE: 'emulator',
      VITE_AUTH_PROVIDER: '',
      VITE_PRIVY_APP_ID: '',
      VITE_PRIVY_CLIENT_ID: '',
      VITE_CHAIN_ID: '',
      VITE_RPC_URL: '',
      VITE_EXPLORER_URL: '',
      VITE_CONTRACT_ADDRESS: '',
      VITE_SUPPORTED_CHAIN_IDS: '',
    },
  },
})
