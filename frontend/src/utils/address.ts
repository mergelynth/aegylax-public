/**
 * Address comparison that survives checksum vs lowercase.
 *
 * RPC nodes, viem and hosted wallets do not agree on whether an address is
 * returned checksummed. Strict `===` then fails for the same account: the
 * Operation screen cannot find "this wallet's" participant, Defense Point
 * or reveal result, and a reload looks like a blank round. Lowercasing is
 * the comparison the chain itself uses.
 */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}

export function includesAddress(addresses: readonly string[], address: string | null | undefined): boolean {
  return addresses.some((entry) => sameAddress(entry, address))
}
