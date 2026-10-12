// Everything about the bridge that is the same for every user: its switches,
// the networks and token pairs, the EVM side of each pair, and whether the
// orchestrators are moving. Read from the chain on load and refreshed on the
// momentum beat.

import { reactive, watch } from 'vue'
import { api, node } from './zenon.ts'
import { walletForReads } from './evm.ts'
import { readClient } from '../evm/client.ts'
import { bridgeAbi, erc20Abi } from '../evm/abi.ts'
import {
  parseMetadata,
  type BridgeInfo,
  type BridgeMetadata,
  type NetworkInfo,
  type OrchestratorInfo,
  type TokenPair,
  type ZtsToken,
} from '../znn/api.ts'
import { assessHealth, isDown, type Health } from '../core/orchestrators.ts'
import { evmChain } from '../config.ts'

export interface EvmToken {
  symbol: string
  name: string
  decimals: number
}

/** The EVM bridge's view of a token (bridge.sol `tokensInfo`). */
export interface EvmTokenInfo {
  minAmount: bigint
  redeemDelay: bigint
  bridgeable: boolean
  redeemable: boolean
  owned: boolean
}

export interface Route {
  key: string
  chainId: number
  networkClass: number
  networkName: string
  /** The EVM bridge contract. */
  contract: `0x${string}`
  pair: TokenPair
  zts: ZtsToken | null
  evm: EvmToken | null
  evmInfo: EvmTokenInfo | null
  /** Zenon to EVM is open: Zenon side bridgeable, EVM side redeemable. */
  canWrap: boolean
  /** EVM to Zenon is open. */
  canUnwrap: boolean
}

export interface EvmNetworkInfo {
  blockTime: number
  confirmations: number
  halted: boolean | null
  error: string
}

export const bridge = reactive({
  loaded: false,
  error: '',
  info: null as BridgeInfo | null,
  meta: {} as BridgeMetadata,
  orch: null as OrchestratorInfo | null,
  networks: [] as NetworkInfo[],
  routes: [] as Route[],
  evmNetworks: {} as Record<number, EvmNetworkInfo>,
  health: null as Health | null,
  healthLoading: false,
})

const tokenCache = new Map<string, ZtsToken | null>()

async function ztsToken(zts: string): Promise<ZtsToken | null> {
  if (!tokenCache.has(zts)) tokenCache.set(zts, await api.value.token(zts).catch(() => null))
  return tokenCache.get(zts) ?? null
}

async function evmSide(chainId: number, contract: `0x${string}`, token: `0x${string}`) {
  const c = readClient(chainId, walletForReads())
  const [meta, info] = await Promise.all([
    Promise.all([
      c.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
      c.readContract({ address: token, abi: erc20Abi, functionName: 'name' }),
      c.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    ]).then(([symbol, name, decimals]) => ({ symbol, name, decimals: Number(decimals) }) as EvmToken).catch(() => null),
    c
      .readContract({ address: contract, abi: bridgeAbi, functionName: 'tokensInfo', args: [token] })
      .then(([minAmount, redeemDelay, bridgeable, redeemable, owned]) => ({ minAmount, redeemDelay, bridgeable, redeemable, owned }))
      .catch(() => null),
  ])
  return { meta, info }
}

async function evmNetwork(chainId: number, contract: `0x${string}`): Promise<EvmNetworkInfo> {
  const c = readClient(chainId, walletForReads())
  try {
    const [bt, conf, halted] = await Promise.all([
      c.readContract({ address: contract, abi: bridgeAbi, functionName: 'estimatedBlockTime' }),
      c.readContract({ address: contract, abi: bridgeAbi, functionName: 'confirmationsToFinality' }),
      c.readContract({ address: contract, abi: bridgeAbi, functionName: 'isHalted' }),
    ])
    return { blockTime: Number(bt), confirmations: Number(conf), halted, error: '' }
  } catch (err) {
    return { blockTime: chainId === 56 ? 3 : 12, confirmations: 0, halted: null, error: (err as Error).message.split('\n')[0] }
  }
}

let loading = false

export async function loadBridge() {
  if (loading) return
  loading = true
  try {
    const a = api.value
    const [info, orch, networks] = await Promise.all([a.bridgeInfo(), a.orchestratorInfo(), a.networks()])
    bridge.info = info
    bridge.meta = parseMetadata(info.metadata)
    bridge.orch = orch
    bridge.networks = networks

    const routes: Route[] = []
    await Promise.all(
      networks.flatMap((n) =>
        n.tokenPairs.map(async (pair) => {
          const contract = n.contractAddress as `0x${string}`
          const [zts, side] = await Promise.all([ztsToken(pair.tokenStandard), evmSide(n.chainId, contract, pair.tokenAddress as `0x${string}`)])
          routes.push({
            key: `${n.chainId}:${pair.tokenStandard}:${pair.tokenAddress}`,
            chainId: n.chainId,
            networkClass: n.networkClass,
            networkName: n.name || evmChain(n.chainId).name,
            contract,
            pair,
            zts,
            evm: side.meta,
            evmInfo: side.info,
            canWrap: pair.bridgeable && (side.info?.redeemable ?? true),
            canUnwrap: pair.redeemable && (side.info?.bridgeable ?? true),
          })
        }),
      ),
    )
    // ZNN first, then QSR, then the rest by symbol, per network.
    const rank = (r: Route) => (r.zts?.symbol === 'ZNN' ? 0 : r.zts?.symbol === 'QSR' ? 1 : 2)
    routes.sort((x, y) => x.chainId - y.chainId || rank(x) - rank(y) || (x.zts?.symbol ?? '').localeCompare(y.zts?.symbol ?? ''))
    bridge.routes = routes

    const nets: Record<number, EvmNetworkInfo> = {}
    await Promise.all(networks.map(async (n) => (nets[n.chainId] = await evmNetwork(n.chainId, n.contractAddress as `0x${string}`))))
    bridge.evmNetworks = nets
    bridge.loaded = true
    bridge.error = ''
  } catch (err) {
    bridge.error = (err as Error).message
  } finally {
    loading = false
  }
}

export async function loadHealth() {
  if (!bridge.info || !bridge.orch) return
  bridge.healthLoading = true
  try {
    const a = api.value
    const [unsigned, blocks, pillars] = await Promise.all([a.unsignedWraps(0, 100), a.bridgeBlocks(3), a.pillarsByProducer()])
    bridge.health = assessHealth({
      now: Date.now() / 1000,
      frontierHeight: node.height,
      momentumSeconds: bridge.orch.estimatedMomentumTime || node.rate,
      halted: bridge.info.halted,
      allowKeyGen: bridge.info.allowKeyGen,
      unsigned: unsigned.list.map((w) => ({
        id: w.id,
        creationMomentumHeight: w.creationMomentumHeight,
        confirmationsToFinality: w.confirmationsToFinality,
        amount: w.amount.toString(),
        symbol: w.token?.symbol ?? '',
        decimals: w.token?.decimals ?? 8,
        chainId: w.chainId,
      })),
      blocks,
      pillarsByProducer: pillars,
    })
  } catch {
    /* keep the last verdict */
  } finally {
    bridge.healthLoading = false
  }
}

/** Halted, key generation, or stalled: new transfers should not start. */
export const bridgeDown = () => (bridge.health ? isDown(bridge.health.state) : Boolean(bridge.info?.halted || bridge.info?.allowKeyGen))

export function startBridge() {
  const first = async () => {
    await loadBridge()
    // Health needs the frontier height; wait for the first momentum if needed.
    if (node.height) void loadHealth()
  }
  void first()
  let lastFull = Date.now()
  let healthAt = 0
  watch(
    () => node.tick,
    () => {
      // A failed first load (a node swap, a dropped socket) is tried again on
      // the next momentum rather than left until the periodic refresh.
      if (!bridge.loaded && !loading) void loadBridge()
      if (!bridge.health && bridge.info && !bridge.healthLoading) void loadHealth()
      const now = Date.now()
      if (now - lastFull > 90_000) {
        lastFull = now
        void loadBridge()
      }
      if (now - healthAt > 120_000 && bridge.health) {
        healthAt = now
        void loadHealth()
      }
    },
  )
  // A new node (the wallet's) means everything is re-read from it.
  watch(
    () => node.url,
    () => {
      tokenCache.clear()
      void first()
    },
  )
}

export function routesFor(chainId: number) {
  return bridge.routes.filter((r) => r.chainId === chainId)
}

export function routeByZts(chainId: number, zts: string) {
  return bridge.routes.find((r) => r.chainId === chainId && r.pair.tokenStandard === zts)
}

export function routeByEvmToken(chainId: number, token: string) {
  return bridge.routes.find((r) => r.chainId === chainId && r.pair.tokenAddress.toLowerCase() === token.toLowerCase())
}
