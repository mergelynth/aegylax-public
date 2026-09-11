import { PROBE_DELAY_BLOCKS } from '../../game/recon'
import type { Address, Hash, ReconProbeRecord } from '../../game/types'

type ProbeClient = {
  advanceBlocks(count: number): void
  sendReconProbe: (
    from: Address,
    params: { lobbyId: Hash; attackId: string; probeId: string; aimDegrees?: number | null },
  ) => Promise<{ tx: { hash: Hash; status: string }; probe: ReconProbeRecord | null }>
  resolvePendingProbes?: (lobbyId: Hash, attackId: string, from: Address) => Promise<ReconProbeRecord[]>
}

/**
 * Send a probe and make sure the reading is actually in hand.
 *
 * Matches the protocol: `sendProbe` computes the hint *and* grants it, so
 * the answer normally comes back with the transaction. The fallback below
 * is for a client that still delivers a delay later — an older deployment,
 * or a confidential network that was not ready — which is exactly what
 * `resolvePendingProbes` exists for.
 */
export async function sendAndCollectProbe(
  client: ProbeClient,
  from: Address,
  params: { lobbyId: Hash; attackId: string; probeId: string; aimDegrees?: number | null },
): Promise<{ tx: { hash: Hash; status: string }; probe: ReconProbeRecord | null }> {
  const { tx, probe } = await client.sendReconProbe(from, params)

  /*
   * Serve the delay, whether or not the reading needed it.
   *
   * `PROBE_DELAY_BLOCKS` is what stands between this probe and the next
   * move it could inform — another probe, or a Defense Point — so a caller
   * that makes either of those next has to have it out of the way. It used
   * to happen implicitly, as the wait for the answer.
   */
  client.advanceBlocks(PROBE_DELAY_BLOCKS)
  if (probe) return { tx, probe }

  const opened = (await client.resolvePendingProbes?.(params.lobbyId, params.attackId, from)) ?? []
  const collected =
    opened.find((entry) => entry.probeId === params.probeId) ?? opened[opened.length - 1] ?? null
  return { tx, probe: collected }
}

/**
 * Serve out `PROBE_DELAY_BLOCKS`.
 *
 * The delay no longer withholds the reading — it gates the next move that
 * reading could inform, which is another probe or a Defense Point. Tests
 * that make either of those moves still have to wait it out.
 */
export function waitOutProbeFlight(client: { advanceBlocks(count: number): void }): void {
  client.advanceBlocks(PROBE_DELAY_BLOCKS)
}

/** How many readings this wallet holds on this attack. */
export async function probesLanded(
  client: Pick<ProbeClient, 'resolvePendingProbes'>,
  lobbyId: Hash,
  attackId: string,
  from: Address,
): Promise<number> {
  return (await client.resolvePendingProbes?.(lobbyId, attackId, from))?.length ?? 0
}

/** True once the send has actually landed, not merely once the button was pressed. */
export async function probeIsOnChain(
  client: Pick<ProbeClient, 'resolvePendingProbes'>,
  lobbyId: Hash,
  attackId: string,
  from: Address,
): Promise<boolean> {
  return (await probesLanded(client, lobbyId, attackId, from)) > 0
}
