// viem clients. Reads go through the connected wallet's own provider when it is
// on the chain being read, so the page uses the user's RPC (and its rate
// limits, not ours). With no wallet, or the wallet on another chain, reads use
// the chain's public fallback from src/config.ts. Writes always go through the
// wallet.

import { createPublicClient, createWalletClient, custom, http, type PublicClient, type WalletClient, defineChain } from 'viem'
import { evmChain } from '../config.ts'
import type { Eip1193Provider } from '../wallet/eip6963.ts'

export function chainDef(chainId: number) {
  const c = evmChain(chainId)
  return defineChain({
    id: chainId,
    name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: c.rpc ? [c.rpc] : [] } },
    blockExplorers: c.explorer ? { default: { name: 'Explorer', url: c.explorer } } : undefined,
  })
}

const fallbackClients = new Map<number, PublicClient>()

export function readClient(chainId: number, wallet: { provider: Eip1193Provider; chainId: number } | null): PublicClient {
  if (wallet && wallet.chainId === chainId) {
    return createPublicClient({ chain: chainDef(chainId), transport: custom(wallet.provider) }) as PublicClient
  }
  let c = fallbackClients.get(chainId)
  if (!c) {
    c = createPublicClient({ chain: chainDef(chainId), transport: http(evmChain(chainId).rpc || undefined, { batch: true }) }) as PublicClient
    fallbackClients.set(chainId, c)
  }
  return c
}

export function writeClient(chainId: number, provider: Eip1193Provider, account: `0x${string}`): WalletClient {
  return createWalletClient({ chain: chainDef(chainId), transport: custom(provider), account })
}
