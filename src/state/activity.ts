// Transfers: the ones sent from this browser (kept locally, so they show the
// moment they are sent) merged with what the chain holds for the connected
// addresses and every recipient used here. Each gets a status from
// core/status.ts, refreshed on the momentum beat.

import { reactive, watch } from 'vue'
import { api, node, syrius, chainId as zenonChain } from './zenon.ts'
import { config } from '../config.ts'
import { evm, walletForReads } from './evm.ts'
import { bridge, routeByEvmToken, routeByZts } from './bridge.ts'
import { readClient } from '../evm/client.ts'
import { bridgeAbi } from '../evm/abi.ts'
import { wrapStatus, unwrapStatus, isAffiliateEntry, type Status } from '../core/status.ts'
import type { UnwrapRequest, WrapRequest } from '../znn/api.ts'

const KEY = 'bridge.activity.v2'
const WATCH_KEY = 'bridge.watch'

export interface LocalWrap {
  kind: 'wrap'
  id: string
  /** Zenon chain identifier; absent on records from before it was kept. */
  znn?: number
  chainId: number
  toAddress: string
  from: string
  tokenStandard: string
  amount: string
  createdAt: number
}

export interface LocalUnwrap {
  kind: 'unwrap'
  txHash: string
  znn?: number
  chainId: number
  toAddress: string
  from: string
  tokenAddress: string
  amount: string
  createdAt: number
}

export type LocalRecord = LocalWrap | LocalUnwrap

export interface Item {
  key: string
  kind: 'wrap' | 'unwrap'
  chainId: number
  toAddress: string
  amount: bigint
  symbol: string
  decimals: number
  createdAt: number
  status: Status<string>
  bonus: boolean
  wrap?: WrapRequest
  unwrap?: UnwrapRequest
  /** Zenon tx of the wrap, or the EVM tx of the unwrap. */
  sourceTx: string
}

export const activity = reactive({
  local: load(),
  items: [] as Item[],
  loading: false,
  loadedOnce: false,
  /** Wrap id -> EVM redeemsInfo block number. Done ones are never re-read. */
  redeemBlocks: {} as Record<string, string>,
  evmBlocks: {} as Record<number, string>,
  busy: {} as Record<string, boolean>,
  /** When items were last built: countdowns run from here. */
  builtAt: 0,
  /** Addresses the user asked to follow without connecting a wallet. */
  watched: loadWatched(),
})

function loadWatched(): string[] {
  try {
    return JSON.parse(localStorage.getItem(WATCH_KEY) || '[]') as string[]
  } catch {
    return []
  }
}

export function setWatched(list: string[]) {
  activity.watched = [...new Set(list)].slice(0, 20)
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify(activity.watched))
  } catch {
    /* holds for this tab */
  }
  void refreshActivity()
}

function load(): LocalRecord[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]') as LocalRecord[]
  } catch {
    return []
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(activity.local.slice(0, 200)))
  } catch {
    /* blocked storage: history lasts for this tab */
  }
}

/** The records sent on the chain the node in use is on. */
const localHere = () => activity.local.filter((r) => (r.znn ?? config.zenonChainId) === zenonChain())

export function remember(r: LocalRecord) {
  activity.local.unshift({ ...r, znn: zenonChain() })
  save()
  void refreshActivity()
}

/** Addresses whose history is read: the connected ones and every recipient used here. */
function addresses() {
  const evmAddrs = new Set<string>()
  const zAddrs = new Set<string>()
  if (evm.account) evmAddrs.add(evm.account.toLowerCase())
  if (syrius.address) zAddrs.add(syrius.address)
  for (const r of localHere()) {
    if (r.kind === 'wrap') evmAddrs.add(r.toAddress.toLowerCase())
    else zAddrs.add(r.toAddress)
  }
  for (const a of activity.watched) {
    if (a.startsWith('0x')) evmAddrs.add(a.toLowerCase())
    else zAddrs.add(a)
  }
  return { evmAddrs: [...evmAddrs], zAddrs: [...zAddrs] }
}

let running = false

export async function refreshActivity() {
  if (running || !api.value || !bridge.orch) return
  running = true
  activity.loading = true
  try {
    const { evmAddrs, zAddrs } = addresses()
    const [wraps, unwraps] = await Promise.all([
      Promise.all(evmAddrs.map((a) => api.value.wrapsTo(a, 0, 50).then((p) => p.list).catch(() => []))),
      Promise.all(zAddrs.map((a) => api.value.unwrapsTo(a, 0, 50).then((p) => p.list).catch(() => []))),
    ])
    const allWraps = dedupe(wraps.flat(), (w) => w.id)
    const allUnwraps = dedupe(unwraps.flat(), (u) => `${u.transactionHash}:${u.logIndex}`)
    await readEvmRedeems(allWraps)
    activity.items = build(allWraps, allUnwraps)
    activity.builtAt = Date.now() / 1000
    activity.loadedOnce = true
  } finally {
    running = false
    activity.loading = false
  }
}

function dedupe<T>(list: T[], key: (x: T) => string): T[] {
  const m = new Map<string, T>()
  for (const x of list) m.set(key(x), x)
  return [...m.values()]
}

const MAX = ((1n << 256n) - 1n).toString()

async function readEvmRedeems(wraps: WrapRequest[]) {
  const byChain = new Map<number, WrapRequest[]>()
  for (const w of wraps) {
    if (!w.signature || activity.redeemBlocks[w.id] === MAX) continue
    byChain.set(w.chainId, [...(byChain.get(w.chainId) ?? []), w])
  }
  await Promise.all(
    [...byChain].map(async ([chainId, list]) => {
      const net = bridge.networks.find((n) => n.chainId === chainId)
      if (!net) return
      const c = readClient(chainId, walletForReads())
      try {
        activity.evmBlocks[chainId] = (await c.getBlockNumber()).toString()
      } catch {
        return
      }
      await Promise.all(
        list.map(async (w) => {
          try {
            const [bn] = await c.readContract({
              address: net.contractAddress as `0x${string}`,
              abi: bridgeAbi,
              functionName: 'redeemsInfo',
              args: [BigInt('0x' + w.id)],
            })
            activity.redeemBlocks[w.id] = bn.toString()
          } catch {
            /* keep the last value */
          }
        }),
      )
    }),
  )
}

function build(wraps: WrapRequest[], unwraps: UnwrapRequest[]): Item[] {
  const momentumSeconds = bridge.orch?.estimatedMomentumTime || node.rate
  const items: Item[] = []
  const now = Date.now() / 1000
  const ageOf = (height: number) => now - Math.max(0, node.height - height) * momentumSeconds
  // A request sent from this browser keeps the time it was sent, so its row
  // does not move when the chain's own (estimated) time takes over.
  const sentAt = new Map<string, number>()
  for (const r of localHere()) sentAt.set(r.kind === 'wrap' ? r.id : r.txHash.replace(/^0x/, '').toLowerCase(), r.createdAt)

  for (const w of wraps) {
    const route = routeByZts(w.chainId, w.tokenStandard)
    const rb = activity.redeemBlocks[w.id]
    const eb = activity.evmBlocks[w.chainId]
    const net = bridge.evmNetworks[w.chainId]
    items.push({
      key: `w:${w.id}`,
      kind: 'wrap',
      chainId: w.chainId,
      toAddress: w.toAddress,
      amount: w.amount - w.fee,
      symbol: route?.evm?.symbol ?? w.token?.symbol ?? '',
      decimals: route?.evm?.decimals ?? w.token?.decimals ?? 8,
      createdAt: sentAt.get(w.id) ?? ageOf(w.creationMomentumHeight),
      bonus: false,
      wrap: w,
      sourceTx: w.id,
      status: wrapStatus({
        signature: w.signature,
        confirmationsToFinality: w.confirmationsToFinality,
        momentumSeconds,
        redeemBlock: rb === undefined ? null : BigInt(rb),
        evmBlock: eb === undefined ? null : BigInt(eb),
        redeemDelay: route?.evmInfo?.redeemDelay ?? null,
        evmBlockSeconds: net?.blockTime ?? 12,
      }),
    })
  }
  // An unwrap keeps one key from the moment it is sent to the moment it is
  // done: `u:<evm tx>`, which is all the page knows before the orchestrators
  // register it. A row that changed key on registration was swapped out and
  // back in, and the list jumped under the pointer (found by the e2e test).
  // Further entries of the same transaction, the referrer's among them, add
  // their log index.
  const seenTx = new Set<string>()
  for (const u of [...unwraps].sort((a, b) => a.logIndex - b.logIndex)) {
    const route = routeByEvmToken(u.chainId, u.tokenAddress)
    const first = !seenTx.has(u.transactionHash)
    seenTx.add(u.transactionHash)
    items.push({
      key: first ? `u:${u.transactionHash}` : `u:${u.transactionHash}:${u.logIndex}`,
      kind: 'unwrap',
      chainId: u.chainId,
      toAddress: u.toAddress,
      amount: u.amount,
      symbol: u.token?.symbol ?? route?.zts?.symbol ?? '',
      decimals: u.token?.decimals ?? 8,
      createdAt: sentAt.get(u.transactionHash) ?? ageOf(u.registrationMomentumHeight),
      bonus: isAffiliateEntry(u.logIndex),
      unwrap: u,
      sourceTx: u.transactionHash,
      status: unwrapStatus({ ...u, momentumSeconds }),
    })
  }
  // Sent here, not on chain yet.
  for (const r of activity.local) {
    if (r.kind === 'wrap' && !wraps.some((w) => w.id === r.id)) {
      const route = routeByZts(r.chainId, r.tokenStandard)
      items.push({
        key: `w:${r.id}`,
        kind: 'wrap',
        chainId: r.chainId,
        toAddress: r.toAddress,
        amount: BigInt(r.amount),
        symbol: route?.evm?.symbol ?? route?.zts?.symbol ?? '',
        decimals: route?.zts?.decimals ?? 8,
        createdAt: r.createdAt,
        bonus: false,
        sourceTx: r.id,
        status: { state: 'confirming', label: 'Confirming', tone: 'wait' },
      })
    }
    if (r.kind === 'unwrap' && !unwraps.some((u) => u.transactionHash.replace(/^0x/, '') === r.txHash.replace(/^0x/, '').toLowerCase())) {
      const route = routeByEvmToken(r.chainId, r.tokenAddress)
      const net = bridge.evmNetworks[r.chainId]
      const wait = (net?.confirmations ?? 0) * (net?.blockTime ?? 12) - (now - r.createdAt)
      items.push({
        key: `u:${r.txHash.replace(/^0x/, '').toLowerCase()}`,
        kind: 'unwrap',
        chainId: r.chainId,
        toAddress: r.toAddress,
        amount: BigInt(r.amount),
        symbol: route?.zts?.symbol ?? '',
        decimals: route?.zts?.decimals ?? 8,
        createdAt: r.createdAt,
        bonus: false,
        sourceTx: r.txHash,
        status: { state: 'signing', label: wait > 0 ? 'Confirming' : 'Signing', tone: 'wait', eta: wait > 0 ? wait : undefined },
      })
    }
  }
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

/** Pending items need watching; done ones do not. */
export const pendingCount = () => activity.items.filter((i) => !['done', 'revoked', 'failed'].includes(i.status.state)).length
export const actionCount = () => activity.items.filter((i) => ['redeem', 'finish'].includes(i.status.state)).length

export function startActivity() {
  let last = 0
  watch(
    () => node.tick,
    () => {
      const now = Date.now()
      // Every ~30 s while something is pending, every 2 min otherwise.
      const every = pendingCount() ? 30_000 : 120_000
      if (now - last > every) {
        last = now
        void refreshActivity()
      }
    },
  )
  watch(
    () => [evm.account, syrius.address, bridge.loaded],
    () => void refreshActivity(),
  )
}
