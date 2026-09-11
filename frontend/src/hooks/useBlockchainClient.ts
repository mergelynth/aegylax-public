import { useContext } from 'react'
import { BlockchainClientContext } from '../app/providers/BlockchainClientProvider'
import type { BlockchainClient } from '../blockchain'

export function useBlockchainClient(): BlockchainClient {
  const client = useContext(BlockchainClientContext)
  if (!client) throw new Error('useBlockchainClient must be used within a BlockchainClientProvider')
  return client
}
