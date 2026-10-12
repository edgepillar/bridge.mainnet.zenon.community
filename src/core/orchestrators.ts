// Whether the bridge is moving, read from the chain alone.
//
// The orchestrators' own health endpoints are not public, and the community
// monitor that polled them (status.bridge.zenon.community) is gone. What the
// chain does show:
//
//   - Orchestrators publish `UpdateWrapRequest` (a wrap's signature) and
//     `UnwrapToken` (an EVM unwrap, signed) from their pillar's producer
//     address. Which one sends rotates by request id, so over a few requests
//     every live orchestrator appears.
//   - `getAllUnsignedWrapTokenRequests` lists wraps still waiting for a
//     signature. One that is long past finality means the ceremony is not
//     happening.
//
// So the verdict is: halted or key generation first (the contract says so),
// then the age of the oldest wrap waiting for a signature, then how long since
// any orchestrator acted.

import type { Tone } from './status.ts'

export const SELECTOR = {
  wrapToken: '61d224bc',
  updateWrapRequest: 'd4bb11c0',
  unwrapToken: 'b6069401',
  redeem: 'd4e06c79',
} as const

export type BridgeState = 'online' | 'idle' | 'delayed' | 'down' | 'halted' | 'keygen' | 'unknown'

/** Past finality, a wrap waiting longer than this for a signature is late. */
export const DELAYED_AFTER_S = 60 * 60
/** And longer than this, the bridge is treated as down. */
export const DOWN_AFTER_S = 6 * 60 * 60
/** An orchestrator action this recent counts as online with nothing waiting. */
export const ACTIVE_WITHIN_S = 24 * 60 * 60

export interface BridgeBlock {
  /** The sender of the paired send block. */
  address: string
  selector: string
  momentumHeight: number
  momentumTimestamp: number
}

export interface UnsignedWrap {
  id: string
  creationMomentumHeight: number
  /** Momentums left to finality, as the node reports it. */
  confirmationsToFinality: number
  amount: string
  symbol: string
  decimals: number
  chainId: number
}

export interface OrchestratorSeen {
  producer: string
  name: string | null
  lastSeen: number
  signs: number
  unwraps: number
}

export interface HealthInputs {
  now: number
  frontierHeight: number
  momentumSeconds: number
  halted: boolean
  allowKeyGen: boolean
  unsigned: UnsignedWrap[]
  blocks: BridgeBlock[]
  pillarsByProducer: Record<string, string>
}

export interface Health {
  state: BridgeState
  label: string
  tone: Tone
  /** One line for a banner; empty when there is nothing to say. */
  message: string
  waiting: Array<UnsignedWrap & { ageSeconds: number }>
  oldestWaitSeconds: number
  lastAction: { at: number; kind: 'sign' | 'unwrap'; producer: string } | null
  orchestrators: OrchestratorSeen[]
  /** Unix time of the oldest block scanned: how far back "seen" reaches. */
  scannedSince: number | null
}

export function orchestratorsFrom(blocks: BridgeBlock[], names: Record<string, string>): OrchestratorSeen[] {
  const seen = new Map<string, OrchestratorSeen>()
  for (const b of blocks) {
    const sign = b.selector === SELECTOR.updateWrapRequest
    const unwrap = b.selector === SELECTOR.unwrapToken
    if (!sign && !unwrap) continue
    let o = seen.get(b.address)
    if (!o) {
      o = { producer: b.address, name: names[b.address] ?? null, lastSeen: 0, signs: 0, unwraps: 0 }
      seen.set(b.address, o)
    }
    if (sign) o.signs++
    else o.unwraps++
    o.lastSeen = Math.max(o.lastSeen, b.momentumTimestamp)
  }
  return [...seen.values()].sort((a, b) => b.lastSeen - a.lastSeen)
}

export function assessHealth(i: HealthInputs): Health {
  const waiting = i.unsigned
    .filter((w) => w.confirmationsToFinality === 0)
    .map((w) => ({ ...w, ageSeconds: Math.max(0, (i.frontierHeight - w.creationMomentumHeight) * i.momentumSeconds) }))
    .sort((a, b) => b.ageSeconds - a.ageSeconds)
  const oldestWaitSeconds = waiting[0]?.ageSeconds ?? 0

  let lastAction: Health['lastAction'] = null
  for (const b of i.blocks) {
    const kind = b.selector === SELECTOR.updateWrapRequest ? 'sign' : b.selector === SELECTOR.unwrapToken ? 'unwrap' : null
    if (kind && (!lastAction || b.momentumTimestamp > lastAction.at)) {
      lastAction = { at: b.momentumTimestamp, kind, producer: b.address }
    }
  }
  const orchestrators = orchestratorsFrom(i.blocks, i.pillarsByProducer)
  const scannedSince = i.blocks.length ? Math.min(...i.blocks.map((b) => b.momentumTimestamp)) : null
  const base = { waiting, oldestWaitSeconds, lastAction, orchestrators, scannedSince }

  if (i.halted) {
    return { ...base, state: 'halted', label: 'Halted', tone: 'danger', message: 'The bridge is halted. Transfers are paused.' }
  }
  if (i.allowKeyGen) {
    return {
      ...base,
      state: 'keygen',
      label: 'Key generation',
      tone: 'warn',
      message: 'Orchestrators are generating a new key. Transfers wait until it is done.',
    }
  }
  if (oldestWaitSeconds >= DOWN_AFTER_S) {
    return {
      ...base,
      state: 'down',
      label: 'Stalled',
      tone: 'danger',
      message: `Orchestrators are not signing. The oldest request has waited ${humanSpan(oldestWaitSeconds)}. New transfers will wait too.`,
    }
  }
  if (oldestWaitSeconds >= DELAYED_AFTER_S) {
    return {
      ...base,
      state: 'delayed',
      label: 'Delayed',
      tone: 'warn',
      message: `Signing is slow. The oldest request has waited ${humanSpan(oldestWaitSeconds)}.`,
    }
  }
  if (lastAction && i.now - lastAction.at <= ACTIVE_WITHIN_S) {
    return { ...base, state: 'online', label: 'Online', tone: 'ok', message: '' }
  }
  if (!lastAction && !i.blocks.length) {
    return { ...base, state: 'unknown', label: 'Unknown', tone: 'dim', message: '' }
  }
  return { ...base, state: 'idle', label: 'Idle', tone: 'dim', message: '' }
}

/** Is it safe to start a new transfer? Halted, key generation and stalled say no. */
export function isDown(state: BridgeState): boolean {
  return state === 'halted' || state === 'keygen' || state === 'down'
}

function humanSpan(seconds: number): string {
  const h = seconds / 3600
  if (h < 48) return `${Math.round(h)} hours`
  return `${Math.round(h / 24)} days`
}
