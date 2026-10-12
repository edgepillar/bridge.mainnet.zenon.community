// The node calls the bridge front end makes, typed from what go-zenon returns
// (rpc/api/embedded/bridge.go, liquidity.go; shapes sampled from mainnet on
// 2026-10-12). Amounts arrive as decimal strings and are converted to bigint
// here, at the edge, so nothing downstream handles a numeric amount.

import { encodeCall } from './abi.ts'
import type { ZenonClient, Momentum } from './client.ts'
import { BRIDGE, LIQUIDITY } from '../config.ts'
import type { BlockSpec } from './block.ts'
import { selectorOf } from './abi.ts'

export interface ZtsToken {
  name: string
  symbol: string
  domain: string
  decimals: number
  tokenStandard: string
  totalSupply: string
  maxSupply: string
  owner: string
}

export interface BridgeInfo {
  administrator: string
  compressedTssECDSAPubKey: string
  decompressedTssECDSAPubKey: string
  allowKeyGen: boolean
  halted: boolean
  unhaltedAt: number
  unhaltDurationInMomentums: number
  tssNonce: number
  metadata: string
}

export interface BridgeMetadata {
  affiliateProgram?: {
    networks?: Record<string, { startingHeight?: number; [symbol: string]: boolean | number | undefined }>
  }
  resignState?: { active: boolean; networkClass: number; chainId: number }
  signCeremonyPoolSize?: number
  keyGenVersion?: string
}

export interface OrchestratorInfo {
  windowSize: number
  keyGenThreshold: number
  confirmationsToFinality: number
  estimatedMomentumTime: number
  allowKeyGenHeight: number
}

export interface TokenPair {
  tokenStandard: string
  tokenAddress: string
  bridgeable: boolean
  redeemable: boolean
  owned: boolean
  minAmount: bigint
  feePercentage: number
  redeemDelay: number
  metadata: string
}

export interface NetworkInfo {
  networkClass: number
  chainId: number
  name: string
  contractAddress: string
  metadata: string
  tokenPairs: TokenPair[]
}

export interface WrapRequest {
  networkClass: number
  chainId: number
  id: string
  toAddress: string
  tokenStandard: string
  tokenAddress: string
  amount: bigint
  fee: bigint
  signature: string
  creationMomentumHeight: number
  token: ZtsToken | null
  confirmationsToFinality: number
}

export interface UnwrapRequest {
  registrationMomentumHeight: number
  networkClass: number
  chainId: number
  transactionHash: string
  logIndex: number
  toAddress: string
  tokenAddress: string
  tokenStandard: string
  amount: bigint
  signature: string
  redeemed: number
  revoked: number
  token: ZtsToken | null
  redeemableIn: number
}

export interface LiquidityInfo {
  administrator: string
  isHalted: boolean
  znnReward: bigint
  qsrReward: bigint
  tokenTuples: Array<{ tokenStandard: string; znnPercentage: number; qsrPercentage: number; minAmount: bigint }>
}

export interface StakeEntry {
  id: string
  amount: bigint
  weightedAmount: bigint
  tokenStandard: string
  startTime: number
  revokeTime: number
  expirationTime: number
  stakeAddress: string
}

export interface Plasma {
  currentPlasma: number
  maxPlasma: number
  qsrAmount: bigint
}

export interface Page<T> {
  count: number
  list: T[]
}

type Raw = Record<string, unknown>
const big = (v: unknown): bigint => {
  if (v === null || v === undefined || v === '') return 0n
  return BigInt(String(v))
}

function pair(r: Raw): TokenPair {
  return { ...(r as unknown as TokenPair), minAmount: big(r.minAmount) }
}

function wrap(r: Raw): WrapRequest {
  return { ...(r as unknown as WrapRequest), amount: big(r.amount), fee: big(r.fee) }
}

function unwrap(r: Raw): UnwrapRequest {
  return { ...(r as unknown as UnwrapRequest), amount: big(r.amount) }
}

function page<T>(r: { count?: number; list?: Raw[] | null } | null, map: (x: Raw) => T): Page<T> {
  return { count: r?.count ?? 0, list: (r?.list ?? []).map(map) }
}

export class ZenonApi {
  readonly c: ZenonClient
  constructor(client: ZenonClient) {
    this.c = client
  }

  frontierMomentum(): Promise<Momentum> {
    return this.c.call('ledger.getFrontierMomentum')
  }

  async momentumAt(height: number): Promise<Momentum | null> {
    const r = await this.c.call<{ list: Momentum[] | null }>('ledger.getMomentumsByHeight', [height, 1])
    return r.list?.[0] ?? null
  }

  async momentums(count: number): Promise<Momentum[]> {
    const r = await this.c.call<{ list: Momentum[] | null }>('ledger.getMomentumsByPage', [0, count])
    return r.list ?? []
  }

  async balances(address: string): Promise<Record<string, bigint>> {
    const r = await this.c.call<{ balanceInfoMap: Record<string, { balance: string }> | null }>(
      'ledger.getAccountInfoByAddress',
      [address],
    )
    const out: Record<string, bigint> = {}
    for (const [zts, b] of Object.entries(r.balanceInfoMap ?? {})) out[zts] = big(b.balance)
    return out
  }

  async plasma(address: string): Promise<Plasma> {
    const r = await this.c.call<Raw>('embedded.plasma.get', [address])
    return { currentPlasma: Number(r.currentPlasma), maxPlasma: Number(r.maxPlasma), qsrAmount: big(r.qsrAmount) }
  }

  token(zts: string): Promise<ZtsToken | null> {
    return this.c.callOrNull('embedded.token.getByZts', [zts])
  }

  async pillarsByProducer(): Promise<Record<string, string>> {
    const r = await this.c.call<{ list: Array<{ name: string; producerAddress: string }> | null }>(
      'embedded.pillar.getAll',
      [0, 1000],
    )
    const out: Record<string, string> = {}
    for (const p of r.list ?? []) out[p.producerAddress] = p.name
    return out
  }

  bridgeInfo(): Promise<BridgeInfo> {
    return this.c.call('embedded.bridge.getBridgeInfo')
  }

  orchestratorInfo(): Promise<OrchestratorInfo> {
    return this.c.call('embedded.bridge.getOrchestratorInfo')
  }

  securityInfo(): Promise<{ guardians: string[]; administratorDelay: number; softDelay: number }> {
    return this.c.call('embedded.bridge.getSecurityInfo')
  }

  async networks(): Promise<NetworkInfo[]> {
    const r = await this.c.call<{ list: Raw[] | null }>('embedded.bridge.getAllNetworks', [0, 100])
    return (r.list ?? []).map((n) => ({ ...(n as unknown as NetworkInfo), tokenPairs: ((n.tokenPairs as Raw[]) ?? []).map(pair) }))
  }

  async feeTokenPair(zts: string): Promise<bigint> {
    const r = await this.c.callOrNull<Raw>('embedded.bridge.getFeeTokenPair', [zts])
    return big(r?.accumulatedFee)
  }

  async wrapsTo(address: string, pageIndex = 0, pageSize = 50): Promise<Page<WrapRequest>> {
    return page(await this.c.call('embedded.bridge.getAllWrapTokenRequestsByToAddress', [address, pageIndex, pageSize]), wrap)
  }

  async wrapById(id: string): Promise<WrapRequest | null> {
    const r = await this.c.callOrNull<Raw>('embedded.bridge.getWrapTokenRequestById', [id])
    return r ? wrap(r) : null
  }

  async allWraps(pageIndex = 0, pageSize = 1): Promise<Page<WrapRequest>> {
    return page(await this.c.call('embedded.bridge.getAllWrapTokenRequests', [pageIndex, pageSize]), wrap)
  }

  async unsignedWraps(pageIndex = 0, pageSize = 100): Promise<Page<WrapRequest>> {
    return page(await this.c.call('embedded.bridge.getAllUnsignedWrapTokenRequests', [pageIndex, pageSize]), wrap)
  }

  async unwrapsTo(address: string, pageIndex = 0, pageSize = 50): Promise<Page<UnwrapRequest>> {
    return page(await this.c.call('embedded.bridge.getAllUnwrapTokenRequestsByToAddress', [address, pageIndex, pageSize]), unwrap)
  }

  async unwrapByHashAndLog(txHash: string, logIndex: number): Promise<UnwrapRequest | null> {
    const r = await this.c.callOrNull<Raw>('embedded.bridge.getUnwrapTokenRequestByHashAndLog', [txHash.replace(/^0x/, ''), logIndex])
    return r ? unwrap(r) : null
  }

  async allUnwraps(pageIndex = 0, pageSize = 1): Promise<Page<UnwrapRequest>> {
    return page(await this.c.call('embedded.bridge.getAllUnwrapTokenRequests', [pageIndex, pageSize]), unwrap)
  }

  /**
   * The bridge contract's own chain, newest first: receive blocks, each paired
   * with the send that called the contract. `pages` × 100 blocks.
   */
  async bridgeBlocks(pages = 2): Promise<
    Array<{ address: string; selector: string; momentumHeight: number; momentumTimestamp: number }>
  > {
    const out: Array<{ address: string; selector: string; momentumHeight: number; momentumTimestamp: number }> = []
    for (let p = 0; p < pages; p++) {
      const r = await this.c.call<{ list: Raw[] | null; count: number }>('ledger.getAccountBlocksByPage', [BRIDGE, p, 100])
      for (const b of r.list ?? []) {
        const send = b.pairedAccountBlock as Raw | null
        const conf = b.confirmationDetail as Raw | null
        if (!send || !conf) continue
        out.push({
          address: String(send.address),
          selector: selectorOf(send.data as string),
          momentumHeight: Number(conf.momentumHeight),
          momentumTimestamp: Number(conf.momentumTimestamp),
        })
      }
      if ((r.list ?? []).length < 100) break
    }
    return out
  }

  async liquidityInfo(): Promise<LiquidityInfo> {
    const r = await this.c.call<Raw>('embedded.liquidity.getLiquidityInfo')
    return {
      ...(r as unknown as LiquidityInfo),
      znnReward: big(r.znnReward),
      qsrReward: big(r.qsrReward),
      tokenTuples: ((r.tokenTuples as Raw[]) ?? []).map((t) => ({ ...(t as unknown as LiquidityInfo['tokenTuples'][0]), minAmount: big(t.minAmount) })),
    }
  }

  async stakeEntries(address: string): Promise<{ totalAmount: bigint; totalWeightedAmount: bigint; list: StakeEntry[] }> {
    const r = await this.c.call<Raw>('embedded.liquidity.getLiquidityStakeEntriesByAddress', [address, 0, 100])
    return {
      totalAmount: big(r.totalAmount),
      totalWeightedAmount: big(r.totalWeightedAmount),
      list: ((r.list as Raw[]) ?? []).map((e) => ({ ...(e as unknown as StakeEntry), amount: big(e.amount), weightedAmount: big(e.weightedAmount) })),
    }
  }

  async uncollectedReward(address: string): Promise<{ znn: bigint; qsr: bigint }> {
    const r = await this.c.call<Raw>('embedded.liquidity.getUncollectedReward', [address])
    return { znn: big(r.znnAmount), qsr: big(r.qsrAmount) }
  }
}

// The blocks a user signs in Syrius. Each is a send to an embedded contract.

export function wrapTokenBlock(o: {
  networkClass: number
  chainId: number
  toAddress: string
  tokenStandard: string
  amount: bigint
}): BlockSpec {
  return {
    toAddress: BRIDGE,
    tokenStandard: o.tokenStandard,
    amount: o.amount,
    data: encodeCall('WrapToken', ['uint32', 'uint32', 'string'], [o.networkClass, o.chainId, o.toAddress.toLowerCase()]),
  }
}

export function redeemBlock(transactionHash: string, logIndex: number): BlockSpec {
  return {
    toAddress: BRIDGE,
    data: encodeCall('Redeem', ['hash', 'uint32'], [transactionHash.replace(/^0x/, ''), logIndex]),
  }
}

export const MONTH_SECONDS = 30 * 24 * 60 * 60

export function liquidityStakeBlock(months: number, tokenStandard: string, amount: bigint): BlockSpec {
  return {
    toAddress: LIQUIDITY,
    tokenStandard,
    amount,
    data: encodeCall('LiquidityStake', ['int64'], [months * MONTH_SECONDS]),
  }
}

export function cancelLiquidityStakeBlock(id: string): BlockSpec {
  return { toAddress: LIQUIDITY, data: encodeCall('CancelLiquidityStake', ['hash'], [id]) }
}

export function collectRewardBlock(): BlockSpec {
  return { toAddress: LIQUIDITY, data: encodeCall('CollectReward', [], []) }
}

export function parseMetadata(raw: string): BridgeMetadata {
  try {
    return JSON.parse(raw) as BridgeMetadata
  } catch {
    return {}
  }
}

/**
 * Whether the affiliate bonus applies to an unwrap of the token paired with
 * `tokenStandard` on `chainId`. The orchestrator keys the program by the EVM
 * token paired with ZNN (flag "wZNN") and with QSR ("wQSR"), from
 * `startingHeight` (HyperCore orchestrator, common/global_state.go).
 */
export function affiliateActive(meta: BridgeMetadata, chainId: number, tokenStandard: string): boolean {
  const n = meta.affiliateProgram?.networks?.[String(chainId)]
  if (!n || !((n.startingHeight ?? 0) > 0)) return false
  if (tokenStandard === 'zts1znnxxxxxxxxxxxxx9z4ulx') return n.wZNN === true
  if (tokenStandard === 'zts1qsrxxxxxxxxxxxxxmrhjll') return n.wQSR === true
  return false
}
