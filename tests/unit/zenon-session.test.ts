import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatAddress } from '../../src/znn/primitives.ts'

const f = vi.hoisted(() => ({ clients: [] as any[], nodes: {} as Record<string, any>, wallet: {} as Record<string, any>, changed: null as null | (() => Promise<void>) }))
vi.mock('../../src/znn/client.ts', () => ({ ZenonClient: class {
  state = 'open'; closed = false; handler: any; onState: any
  constructor(public url: string) { f.clients.push(this) }
  frontierMomentum() { return f.nodes[this.url]?.frontier?.() ?? Promise.resolve({ chainIdentifier: 1, height: 3, timestamp: Date.now() / 1000 }) }
  close() { this.closed = true }
  onMomentum(handler: any) { this.handler = handler; return () => { this.handler = null } }
} }))
vi.mock('../../src/znn/api.ts', () => ({ ZenonApi: class {
  constructor(public c: any) {}
  momentums() { return Promise.resolve(f.nodes[this.c.url]?.rows ?? [1, 2, 3].map((height) => ({ height, timestamp: Date.now() / 1000 - (3 - height) * 10 }))) }
  momentumAt(height: number) { return f.nodes[this.c.url]?.momentumAt?.(height) ?? Promise.resolve({ height, timestamp: Date.now() / 1000 + height - 3 }) }
} }))
vi.mock('../../src/wallet/syrius.ts', () => ({
  whenProviderReady: (...a: any[]) => f.wallet.ready(...a), readState: (...a: any[]) => f.wallet.read(...a), connect: (...a: any[]) => f.wallet.connect(...a),
  disconnect: (...a: any[]) => f.wallet.disconnect(...a), sendAccountBlock: (...a: any[]) => f.wallet.send(...a),
  onWalletChange: (handler: any) => { f.changed = handler; return () => {} },
}))
const account = formatAddress(Uint8Array.from([0, ...Array(19).fill(7)])), hash = 'ab'.repeat(32)
const defaultUrl = 'wss://default.fixture.invalid', walletUrl = 'wss://wallet.fixture.invalid'
const state = () => ({ present: true, protocol: '2', extensionVersion: null, address: account, chainId: 1, nodeUrl: walletUrl, canSignMessage: false })
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); f.clients = []; f.nodes = {}; f.changed = null
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) })
  vi.stubGlobal('location', { protocol: 'https:' }); vi.stubGlobal('window', {})
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, job) => job({ name: 'fixture-owned-lock' })) } })
  f.wallet = { ready: vi.fn(async () => true), read: vi.fn(async () => state()), connect: vi.fn(async () => state()), disconnect: vi.fn(async () => {}),
    send: vi.fn(async (_template, options) => { options.beforePrompt(); return { hash } }),
  }
  const { config } = await import('../../src/config.ts'); config.defaultNodes = [defaultUrl]; config.defaultNode = defaultUrl
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function connected() {
  const z = await import('../../src/state/zenon.ts'); await z.startNode(); await vi.waitFor(() => expect(z.node.height).toBe(3)); await z.connectSyrius(); return z
}
describe('selected Zenon node and wallet session authority', () => {
  it('falls back after an unavailable node and refreshes only the selected momentum stream', async () => {
    const { config } = await import('../../src/config.ts'); config.defaultNodes = ['wss://offline.fixture.invalid', defaultUrl]
    f.nodes[config.defaultNodes[0]] = { frontier: () => Promise.reject(new Error('offline')) }
    const z = await import('../../src/state/zenon.ts'); await z.startNode(); await vi.waitFor(() => expect(z.node.height).toBe(3))
    expect(f.clients[0].closed).toBe(true); expect(z.node.rate).toBe(10); expect(z.nodeIsCurrent()).toBe(true)
    const owner = f.clients[1]; owner.handler({ height: 4 }); await vi.waitFor(() => expect(z.node.height).toBe(4))
    owner.handler({ height: 3, timestamp: 1 }); expect(z.node.height).toBe(4)
    owner.onState('closed'); expect(z.nodeIsCurrent()).toBe(false)
  })
  it('keeps unavailable default-chain identity unestablished when every probe fails', async () => {
    f.nodes[defaultUrl] = { frontier: () => Promise.reject(new Error('offline')), rows: [] }
    const z = await import('../../src/state/zenon.ts'); await z.startNode()
    expect(z.node.chainId).toBe(0); expect(z.nodeIsCurrent()).toBe(false); expect(f.clients[0].closed).toBe(true)
  })
  it('invalidates a disconnected transport and requires a fresh frontier before reopening authority', async () => {
    const z = await connected(), owner = f.clients[0], epoch = z.node.epoch, gate = deferred<any>()
    f.nodes[defaultUrl] = { frontier: () => gate.promise, rows: [] }
    owner.onState('closed')
    expect(z.node).toMatchObject({ chainId: 0, height: 0, timestamp: 0 }); expect(z.node.epoch).toBeGreaterThan(epoch)
    owner.onState('open'); expect(z.nodeIsCurrent()).toBe(false)
    gate.resolve({ hash, chainIdentifier: 1, height: 10, timestamp: Date.now() / 1000 })
    await vi.waitFor(() => expect(z.nodeIsCurrent()).toBe(true))
    expect(z.node).toMatchObject({ chainId: 1, height: 10 })
  })
  it('discards a delayed seed from the previous socket of the same client', async () => {
    const oldSeed = deferred<any>()
    f.nodes[defaultUrl] = { rows: oldSeed.promise }
    const z = await import('../../src/state/zenon.ts'); await z.startNode(); const owner = f.clients[0]
    f.nodes[defaultUrl] = { frontier: async () => ({ hash, chainIdentifier: 1, height: 10, timestamp: Date.now() / 1000 }), rows: [] }
    owner.onState('closed'); owner.onState('open')
    await vi.waitFor(() => expect(z.node.height).toBe(10))
    oldSeed.resolve([{ height: 999, timestamp: Date.now() / 1000 }]); await Promise.resolve(); await Promise.resolve()
    expect(z.node.height).toBe(10)
  })
  it('rejects stale frontier completions across consecutive reconnects', async () => {
    const z = await connected(), owner = f.clients[0], retired = deferred<any>(), current = deferred<any>()
    f.nodes[defaultUrl] = { frontier: () => retired.promise, rows: [] }
    owner.onState('closed'); owner.onState('open')
    f.nodes[defaultUrl].frontier = () => current.promise
    owner.onState('closed'); owner.onState('open')
    retired.resolve({ hash, chainIdentifier: 322, height: 999, timestamp: Date.now() / 1000 })
    await Promise.resolve(); await Promise.resolve(); expect(z.node.chainId).toBe(0); expect(z.nodeIsCurrent()).toBe(false)
    current.resolve({ hash, chainIdentifier: 1, height: 10, timestamp: Date.now() / 1000 })
    await vi.waitFor(() => expect(z.nodeIsCurrent()).toBe(true)); expect(z.node.chainId).toBe(1); expect(z.node.height).toBe(10)
  })
  it('drops a remembered wallet endpoint if its new transport reports another chain', async () => {
    const z = await connected(); await z.requestWalletNode(); z.confirmWalletNode()
    const owner = f.clients.at(-1)
    f.nodes[walletUrl] = { frontier: async () => ({ hash, chainIdentifier: 322, height: 10, timestamp: Date.now() / 1000 }), rows: [] }
    owner.onState('closed'); owner.onState('open')
    await vi.waitFor(() => expect(z.node.source).toBe('default'))
    expect(owner.closed).toBe(true); expect(localStorage.getItem('bridge.node')).toBeNull(); expect(z.node.notice).toContain('changed chain')
    expect(z.node.chainId).not.toBe(322)
  })
  it('discards a retired transport subscription lookup after reconnecting', async () => {
    const z = await connected(), owner = f.clients[0], oldLookup = deferred<any>()
    f.nodes[defaultUrl] = { momentumAt: () => oldLookup.promise, rows: [], frontier: async () => ({ hash, chainIdentifier: 1, height: 10, timestamp: Date.now() / 1000 }) }
    owner.handler({ height: 999, timestamp: 0, chainIdentifier: 0 })
    owner.onState('closed'); owner.onState('open'); await vi.waitFor(() => expect(z.node.height).toBe(10))
    oldLookup.resolve({ hash, chainIdentifier: 1, height: 999, timestamp: Date.now() / 1000 }); await Promise.resolve(); await Promise.resolve()
    expect(z.node.height).toBe(10)
  })
  it('coalesces frontier recovery reads and keeps failed revalidation unavailable', async () => {
    const z = await connected(), owner = f.clients[0], gate = deferred<any>(), frontier = vi.fn(() => gate.promise)
    f.nodes[defaultUrl] = { frontier, rows: [] }
    owner.onState('closed'); owner.onState('open')
    for (let i = 0; i < 5; i++) owner.handler({ height: 10, timestamp: Date.now() / 1000, chainIdentifier: 1 })
    expect(frontier).toHaveBeenCalledTimes(1); expect(z.nodeIsCurrent()).toBe(false)
    gate.resolve({ hash, chainIdentifier: 1, height: 10, timestamp: Date.now() / 1000 })
    await vi.waitFor(() => expect(z.nodeIsCurrent()).toBe(true))
    owner.onState('closed'); f.nodes[defaultUrl].frontier = vi.fn(async () => { throw new Error('frontier unavailable') }); owner.onState('open')
    await Promise.resolve(); await Promise.resolve(); expect(z.node.chainId).toBe(0); expect(z.nodeIsCurrent()).toBe(false)
    f.nodes[defaultUrl].frontier = vi.fn(async () => ({ hash, chainIdentifier: 1, height: 11, timestamp: Date.now() / 1000 }))
    owner.handler({ height: 11, timestamp: 0, chainIdentifier: 0 }); await vi.waitFor(() => expect(z.node.height).toBe(11))
    expect(z.nodeIsCurrent()).toBe(true)
  })
  it('does not replace a newer subscription rate with a late older seed', async () => {
    const gate = deferred<any>(); f.nodes[defaultUrl] = { rows: gate.promise }
    const z = await import('../../src/state/zenon.ts'); await z.startNode()
    const owner = f.clients[0], now = Date.now() / 1000
    for (const [height, timestamp] of [[100, now - 20], [101, now - 10], [102, now]]) owner.handler({ height, timestamp })
    expect(z.node.rate).toBe(10)
    gate.resolve([{ height: 1, timestamp: 1 }, { height: 2, timestamp: 2 }, { height: 3, timestamp: 3 }]); await Promise.resolve(); await Promise.resolve()
    expect(z.node.height).toBe(102); expect(z.node.rate).toBe(10)
  })
  it('requires explicit wallet-node confirmation and clears the saved choice when default is selected', async () => {
    const z = await connected(); await z.requestWalletNode()
    expect(z.node.source).toBe('default'); expect(z.walletNode.pending).toEqual({ url: walletUrl, chainId: 1, kind: 'wallet' })
    z.confirmWalletNode(); expect(z.node.source).toBe('wallet'); expect(localStorage.getItem('bridge.node')).toContain(walletUrl)
    z.useDefaultNode(); expect(z.node.source).toBe('default'); expect(localStorage.getItem('bridge.node')).toBeNull()
  })
  it('closes a stale wallet-node probe after the account changes before it answers', async () => {
    const z = await connected(), gate = deferred<any>(); f.nodes[walletUrl] = { frontier: () => gate.promise }
    const pending = z.requestWalletNode(); z.syrius.address = null; gate.resolve({ chainIdentifier: 1 }); await pending
    expect(z.walletNode.pending).toBeNull(); expect(f.clients.at(-1).closed).toBe(true)
  })
  it('restores only a saved wallet node with its originally accepted chain', async () => {
    localStorage.setItem('bridge.node', JSON.stringify({ url: walletUrl, chainId: 1 }))
    const z = await connected(); expect(z.node.source).toBe('wallet')
    await z.disconnectSyrius(); expect(z.node.source).toBe('default'); expect(z.syrius.address).toBeNull()
    f.nodes[walletUrl] = { frontier: async () => ({ chainIdentifier: 322 }) }
    await z.connectSyrius(); expect(z.node.source).toBe('default'); expect(z.node.notice).toContain('changed chain'); expect(localStorage.getItem('bridge.node')).toBeNull()
  })
  it('invalidates a remembered node when the wallet changes its endpoint', async () => {
    localStorage.setItem('bridge.node', JSON.stringify({ url: walletUrl, chainId: 1 }))
    const z = await connected(); f.wallet.read.mockResolvedValue({ ...state(), nodeUrl: 'wss://different.fixture.invalid' })
    await z.detectSyrius(); expect(z.node.source).toBe('default'); expect(z.node.notice).toContain('changed its node'); expect(localStorage.getItem('bridge.node')).toBeNull()
  })
  it('does not restore a late detected wallet after a local disconnect', async () => {
    const z = await import('../../src/state/zenon.ts'), gate = deferred<any>(); f.wallet.read.mockImplementation(() => gate.promise)
    const pending = z.detectSyrius(); await vi.waitFor(() => expect(f.wallet.read).toHaveBeenCalled())
    await z.disconnectSyrius(); gate.resolve(state()); await pending; expect(z.syrius.address).toBeNull()
    await f.changed?.(); expect(f.wallet.read).toHaveBeenCalledTimes(1)
  })
  it('refuses stale context before publication and releases busy state without replacing the original request', async () => {
    const z = await connected()
    await expect(z.sendBlock({ toAddress: account }, () => { throw new Error('intent changed') })).rejects.toThrow('intent changed')
    expect(f.wallet.send).not.toHaveBeenCalled(); expect(z.syrius.busy).toBe(false)
    z.syrius.chainId = 322; await expect(z.sendBlock({ toAddress: account })).rejects.toThrow('chain')
    z.syrius.chainId = 1; z.node.conn = 'closed'; await expect(z.sendBlock({ toAddress: account })).rejects.toThrow('freshness')
  })
  it('blocks a send until the node is known, but says the chains differ only when both are known', async () => {
    const z = await connected(), saved = z.node.chainId
    z.node.chainId = 0; expect(z.wrongZenonChain()).toBe(true); expect(z.zenonChainMismatch()).toBe(false)
    z.node.chainId = saved; z.syrius.chainId = null; expect(z.wrongZenonChain()).toBe(true); expect(z.zenonChainMismatch()).toBe(false)
    z.syrius.chainId = 322; expect(z.zenonChainMismatch()).toBe(true)
    z.syrius.chainId = saved; expect(z.zenonChainMismatch()).toBe(false)
  })
  it('retains a delayed original publication under its original account and chain', async () => {
    const z = await connected(), gate = deferred<any>(); f.wallet.send.mockImplementation((_template: any, options: any) => { options.beforePrompt(); return gate.promise })
    const pending = z.sendBlock({ toAddress: account }); await vi.waitFor(() => expect(f.wallet.send).toHaveBeenCalled())
    z.syrius.address = null; gate.resolve({ hash }); await expect(pending).resolves.toBe(hash)
    const { operations } = await import('../../src/state/operations.ts')
    expect(operations.entries[0]).toMatchObject({ account, chainId: 1, hash, state: 'submitted' }); expect(f.wallet.send).toHaveBeenCalledTimes(1)
  })
  it('rejects insecure or credential-bearing wallet endpoints while permitting explicit loopback', async () => {
    const z = await import('../../src/state/zenon.ts')
    for (const value of [null, 'embedded', 'ws://remote.fixture.invalid', 'https://name:secret@fixture.invalid', 'wss://fixture.invalid/#fragment']) expect(z.nodeProblem(value)).not.toBe('')
    expect(z.nodeProblem('ws://127.0.0.1:46998')).toBe(''); expect(z.nodeProblem('https://fixture.invalid')).toBe('')
    expect(z.hostOf('wss://fixture.invalid:123')).toBe('fixture.invalid:123'); expect(z.hostOf('unavailable')).toBe('unavailable')
    expect(z.networkLabel()).toBe('Mainnet'); expect(z.onBuildChain()).toBe(true); expect(z.wrongZenonChain()).toBe(false); expect(z.zenonChainMismatch()).toBe(false)
  })
})
