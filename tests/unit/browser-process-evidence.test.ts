import { expect, it } from 'vitest'
import { browserProcessEvidence } from '../../e2e/lib/browser-process-evidence.ts'

const processes = (...ids: number[]) => ({ processInfo: ids.map(id => ({ type: 'network.mojom.NetworkService', id })) })

it('detects a replaced network service even when the service count is unchanged', async () => {
  const values = [processes(19001), processes(19002)]
  const evidence = await browserProcessEvidence(async () => values.shift())
  await evidence.captureFailure()
  expect(evidence.report().failures).toEqual([{ sample: { status: 'COMPLETE', networkServices: 1 }, networkServiceChanged: true }])
})

it('distinguishes an unchanged service from a service removed without a replacement', async () => {
  const values = [processes(19001), processes(19001), processes()]
  const evidence = await browserProcessEvidence(async () => values.shift())
  await evidence.captureFailure(); await evidence.captureFailure()
  expect(evidence.report().failures.map(x => x.networkServiceChanged)).toEqual([false, true])
})

it('leaves the comparison unknown when a baseline service was not identified', async () => {
  const values = [processes(), processes(19001)]
  const evidence = await browserProcessEvidence(async () => values.shift())
  await evidence.captureFailure()
  expect(evidence.report().failures[0].networkServiceChanged).toBeNull()
})

it('does not retain process identifiers, unrelated process data or raw query errors', async () => {
  const evidence = await browserProcessEvidence(async () => ({ processInfo: [
    { type: 'network.mojom.NetworkService', id: 987654321, command: '/PRIVATE_PATH/PRIVATE_VALUE' },
    { type: 'PRIVATE_PROCESS', id: 987654322 },
  ] }))
  await evidence.captureFailure()
  expect(JSON.stringify(evidence.report())).not.toMatch(/PRIVATE|987654321|987654322/)
  const unavailable = await browserProcessEvidence(async () => { throw new Error('PRIVATE_ERROR') })
  await unavailable.captureFailure()
  expect(unavailable.report().failures[0].networkServiceChanged).toBeNull()
  expect(JSON.stringify(unavailable.report())).not.toContain('PRIVATE')
})

it('marks malformed, duplicate and oversized process inventories unavailable', async () => {
  for (const value of [null, {}, { processInfo: 'PRIVATE' }, processes(0), processes(1, 1), processes(...Array.from({ length: 65 }, (_, i) => i + 1))]) {
    const evidence = await browserProcessEvidence(async () => value)
    expect(evidence.report().baseline).toEqual({ status: 'UNAVAILABLE', reason: 'INVALID_SCHEMA' })
  }
})

it('bounds concurrent failure samples and performs no idle process polling', async () => {
  let calls = 0
  const evidence = await browserProcessEvidence(async () => { calls++; return processes(19001) })
  expect(calls).toBe(1)
  expect(evidence.report().failures).toEqual([])
  await Promise.all(Array.from({ length: 12 }, () => evidence.captureFailure()))
  expect(calls).toBe(9)
  expect(evidence.report().failures).toHaveLength(8)
  expect(evidence.report().truncated).toBe(true)
})

it('records a bounded deadline without treating missing process evidence as stability', async () => {
  const evidence = await browserProcessEvidence(() => new Promise(() => {}), 1)
  await evidence.captureFailure()
  expect(evidence.report().baseline).toEqual({ status: 'UNAVAILABLE', reason: 'DEADLINE' })
  expect(evidence.report().failures[0].networkServiceChanged).toBeNull()
  await expect(browserProcessEvidence(async () => processes(1), 0)).rejects.toThrow()
  await expect(browserProcessEvidence(async () => processes(1), 2001)).rejects.toThrow()
})
