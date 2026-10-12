import { describe, expect, it } from 'vitest'
import { assessHealth, orchestratorsFrom, isDown, SELECTOR, type HealthInputs } from '../../src/core/orchestrators.ts'

const DAY = 86400
const now = 1_791_805_000
const base: HealthInputs = {
  now,
  frontierHeight: 14_402_636,
  momentumSeconds: 10,
  halted: false,
  allowKeyGen: false,
  unsigned: [],
  blocks: [],
  pillarsByProducer: { z1a: 'Alpha', z1b: 'Beta' },
}
const sign = (address: string, at: number) => ({ address, selector: SELECTOR.updateWrapRequest, momentumHeight: 1, momentumTimestamp: at })
const unwrap = (address: string, at: number) => ({ address, selector: SELECTOR.unwrapToken, momentumHeight: 1, momentumTimestamp: at })
const user = (at: number) => ({ address: 'z1user', selector: SELECTOR.wrapToken, momentumHeight: 1, momentumTimestamp: at })
const waiting = (createdAgo: number, conf = 0) => ({
  id: String(createdAgo),
  creationMomentumHeight: base.frontierHeight - createdAgo / 10,
  confirmationsToFinality: conf,
  amount: '1',
  symbol: 'ZNN',
  decimals: 8,
  chainId: 1,
})

describe('assessHealth', () => {
  it('says halted first, whatever else is true', () => {
    expect(assessHealth({ ...base, halted: true, unsigned: [waiting(30 * DAY)] }).state).toBe('halted')
  })
  it('says key generation next', () => {
    expect(assessHealth({ ...base, allowKeyGen: true }).state).toBe('keygen')
  })
  it('says stalled for mainnet as read on 2026-10-12', () => {
    // Three wraps waiting, the oldest ~34 days; last signature 2026-08-30.
    const h = assessHealth({
      ...base,
      unsigned: [waiting(34 * DAY), waiting(28 * DAY), waiting(16 * DAY)],
      blocks: [sign('z1a', now - 42 * DAY), unwrap('z1b', now - 50 * DAY), user(now - 16 * DAY)],
    })
    expect(h.state).toBe('down')
    expect(h.label).toBe('Stalled')
    expect(h.message).toContain('34 days')
    expect(h.waiting.map((w) => w.id)).toEqual([String(34 * DAY), String(28 * DAY), String(16 * DAY)])
    expect(h.lastAction).toMatchObject({ kind: 'sign', producer: 'z1a' })
    expect(isDown(h.state)).toBe(true)
  })
  it('says delayed between one and six hours', () => {
    expect(assessHealth({ ...base, unsigned: [waiting(2 * 3600)], blocks: [sign('z1a', now - 60)] }).state).toBe('delayed')
  })
  it('does not count a wrap still waiting for finality', () => {
    expect(assessHealth({ ...base, unsigned: [waiting(30 * DAY, 5)], blocks: [sign('z1a', now - 60)] }).state).toBe('online')
  })
  it('says online after a recent signature with nothing late', () => {
    const h = assessHealth({ ...base, unsigned: [waiting(600)], blocks: [sign('z1a', now - 3600)] })
    expect(h.state).toBe('online')
    expect(h.message).toBe('')
    expect(isDown(h.state)).toBe(false)
  })
  it('says idle when nothing is waiting and nothing was signed lately', () => {
    expect(assessHealth({ ...base, blocks: [sign('z1a', now - 10 * DAY)] }).state).toBe('idle')
  })
  it('says unknown with no data at all', () => {
    expect(assessHealth(base).state).toBe('unknown')
  })
})

describe('orchestratorsFrom', () => {
  it('counts signatures and unwraps per producer, names pillars, newest first', () => {
    const list = orchestratorsFrom([sign('z1a', 100), sign('z1a', 300), unwrap('z1a', 200), unwrap('z1b', 400), user(500), sign('z1c', 50)], base.pillarsByProducer)
    expect(list.map((o) => o.producer)).toEqual(['z1b', 'z1a', 'z1c'])
    expect(list[1]).toMatchObject({ name: 'Alpha', signs: 2, unwraps: 1, lastSeen: 300 })
    expect(list[2].name).toBeNull()
  })
})
