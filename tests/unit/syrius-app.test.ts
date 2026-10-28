import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatAddress } from '../../src/znn/primitives.ts'

const f = vi.hoisted(() => ({ clients: [] as any[], nodes: {} as Record<string, any> }))
vi.mock('../../src/znn/client.ts', () => ({ ZenonClient: class {
  state = 'open'; closed = false; handler: any; onState: any
  constructor(public url: string) { f.clients.push(this) }
  frontierMomentum() { return f.nodes[this.url]?.frontier?.() ?? Promise.resolve({ chainIdentifier: 1, height: 3, timestamp: Date.now() / 1000 }) }
  close() { this.closed = true }
  onMomentum(handler: any) { this.handler = handler; return () => { this.handler = null } }
} }))
vi.mock('../../src/znn/api.ts', () => ({ ZenonApi: class {
  constructor(public c: any) {}
  momentums() { return Promise.resolve([1, 2, 3].map((height) => ({ height, timestamp: Date.now() / 1000 - (3 - height) * 10 }))) }
  momentumAt(height: number) { return Promise.resolve({ height, timestamp: Date.now() / 1000 + height - 3 }) }
} }))

const account = formatAddress(Uint8Array.from([0, ...Array(19).fill(7)])), other = formatAddress(Uint8Array.from([0, ...Array(19).fill(8)]))
const hash = 'ab'.repeat(32), defaultUrl = 'wss://default.fixture.invalid'
const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36'
let storage: Map<string, string>, surface: any, scripts: { textContent: string }[], replaced: string[]

const appDecode = (text: string) => new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), (c) => c.charCodeAt(0)))
const opened = () => new URL(surface.location.href)
const answerUrl = (id: string, key: 'result' | 'error', value: unknown, callback = opened().searchParams.get('callback')!) => {
  const u = new URL(callback); u.searchParams.set('id', id)
  u.searchParams.set(key, btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''))
  return u.toString()
}

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); f.clients = []; f.nodes = {}
  storage = new Map(); scripts = []; replaced = []
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) })
  surface = { location: { href: 'https://bridge.fixture.invalid/#/', protocol: 'https:', origin: 'https://bridge.fixture.invalid', pathname: '/', hash: '#/' },
    addEventListener: vi.fn(), removeEventListener: vi.fn() }
  vi.stubGlobal('window', surface); vi.stubGlobal('location', surface.location)
  vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url); surface.location.href = url } })
  vi.stubGlobal('document', { querySelectorAll: () => scripts, documentElement: {}, createElement: () => ({}) })
  vi.stubGlobal('navigator', { userAgent: android, maxTouchPoints: 5, locks: { request: vi.fn(async (_name, _options, job) => job({ name: 'fixture-owned-lock' })) } })
  const { config } = await import('../../src/config.ts'); config.defaultNodes = [defaultUrl]; config.defaultNode = defaultUrl; config.zenonChainId = 1
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('Syrius app links', () => {
  it('builds a request the app can read and a callback it accepts', async () => {
    const a = await import('../../src/wallet/syriusApp.ts')
    const params = { note: 'zürich ✓', n: [1, 2] }
    const link = new URL(a.requestLink('znn_signAndSendBlock', params, 'id-1', a.callbackUrl('activity')))
    expect(link.protocol).toBe('syrius:'); expect(link.host).toBe('request')
    expect(JSON.parse(appDecode(link.searchParams.get('params')!))).toEqual(params)
    expect(link.searchParams.get('callback')).toBe('https://bridge.fixture.invalid/?syrius=1#/activity')
    expect(a.base64url.decode(a.base64url.encode('zürich ✓'))).toBe('zürich ✓')
  })
  it('reads an answer once, strips it from the address and keeps the route', async () => {
    const a = await import('../../src/wallet/syriusApp.ts')
    surface.location.href = answerUrl('id-1', 'result', [account], a.callbackUrl('activity'))
    expect(a.takeAnswerFromUrl()).toEqual({ id: 'id-1', result: [account] })
    expect(replaced).toEqual(['https://bridge.fixture.invalid/#/activity'])
    expect(a.takeAnswerFromUrl()).toBeNull()
    expect(a.parseAnswer('x', null, 'not base64 json')).toMatchObject({ error: { code: -32603 } })
    expect(a.parseAnswer('x', null, a.base64url.encode(JSON.stringify({ code: 4001, message: 'no' })))).toEqual({ id: 'x', error: { code: 4001, message: 'no' } })
    expect(a.parseAnswer('x'.repeat(129), '', null)).toBeNull()
  })
  it('keeps requests across tabs until answered or expired', async () => {
    const a = await import('../../src/wallet/syriusApp.ts'), urls: string[] = []
    const r = a.openRequest('znn_connect', [], {}, '', (u) => urls.push(u))
    expect(urls[0]).toContain(`id=${r.id}`)
    expect(a.takePending('other')).toBeNull(); expect(a.takePending(r.id)).toMatchObject({ method: 'znn_connect' }); expect(a.takePending(r.id)).toBeNull()
    const late = a.openRequest('znn_chainId', [], {}, '', () => {})
    vi.setSystemTime(Date.now() + a.REQUEST_TTL_MS)
    expect(a.takePending(late.id)).toBeNull()
  })
  it('takes a phone for a phone, an iPad for one, and a desktop for neither', async () => {
    const a = await import('../../src/wallet/syriusApp.ts')
    expect(a.isPhone({ userAgent: android, maxTouchPoints: 5 })).toBe(true)
    expect(a.isPhone({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', maxTouchPoints: 5 })).toBe(true)
    expect(a.isPhone({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', maxTouchPoints: 5 })).toBe(true)
    expect(a.isPhone({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', maxTouchPoints: 0 })).toBe(false)
    expect(a.isPhone({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0', maxTouchPoints: 0 })).toBe(false)
  })
})

describe('Syrius v0.1.x under this page\'s CSP', () => {
  it('finds the blocked inline script and defers to a modern provider', async () => {
    const l = await import('../../src/wallet/syriusLegacy.ts')
    expect(l.legacyPresent()).toBe(false)
    scripts = [{ textContent: '\n  window.zenon = {};\n  window.zenon.isSyriusExtension = true;\n' }]
    expect(l.legacyPresent()).toBe(true)
    surface.zenon = { sendAccountBlock: () => {} }
    expect(l.legacyPresent()).toBe(false)
  })
})

async function phone() {
  const z = await import('../../src/state/zenon.ts'), ops = await import('../../src/state/operations.ts'), t = await import('../../src/state/toasts.ts')
  await z.startNode(); await vi.waitFor(() => expect(z.node.height).toBe(3))
  const detected = z.detectSyrius(); await vi.advanceTimersByTimeAsync(1500); await detected
  return { z, ops, t }
}
async function answer(key: 'result' | 'error', value: unknown) {
  const id = opened().searchParams.get('id')!, url = answerUrl(id, key, value)
  const a = await import('../../src/wallet/syriusApp.ts'), z = await import('../../src/state/zenon.ts')
  surface.location.href = url; z.applyAppAnswer(a.takeAnswerFromUrl()!)
}
async function connectedPhone() {
  const s = await phone()
  await expect(s.z.connectSyrius()).rejects.toMatchObject({ name: 'AppHandoffError' })
  await answer('result', [account])
  s.z.checkSyriusNetwork(); await answer('result', 1)
  return s
}
const spec = () => ({ toAddress: other, amount: 5n })

describe('Syrius app session', () => {
  it('connects by link, and sends nothing until the network is checked', async () => {
    const { z, t } = await phone()
    expect(z.syrius).toMatchObject({ present: false, app: true, address: null })
    await expect(z.connectSyrius()).rejects.toMatchObject({ name: 'AppHandoffError' })
    expect(opened().searchParams.get('method')).toBe('znn_connect')
    await answer('result', [account])
    expect(z.syrius).toMatchObject({ address: account, chainId: null }); expect(t.toasts[0].text).toBe('Syrius connected')
    await expect(z.sendBlock(spec())).rejects.toThrow('Check network first')
    z.checkSyriusNetwork(); expect(opened().searchParams.get('method')).toBe('znn_chainId')
    await answer('result', 1)
    expect(z.syrius.chainId).toBe(1); expect(z.wrongZenonChain()).toBe(false)
  })
  it('records a send as unknown when handed off, and submitted when the app answers with the same block', async () => {
    const { z, ops } = await connectedPhone(), sent = vi.fn()
    z.onAppSent(sent)
    await expect(z.sendBlock(spec(), () => {}, { kind: 'wrap', fixture: true })).rejects.toMatchObject({ name: 'AppHandoffError' })
    const op = ops.operations.entries.at(-1)!
    expect(op.state).toBe('unknown')
    const template = JSON.parse(appDecode(opened().searchParams.get('params')!))
    expect(template).toMatchObject({ toAddress: other, amount: '5', chainIdentifier: 1 })
    await answer('result', { hash, block: { ...template, hash, address: account } })
    expect(op).toMatchObject({ state: 'submitted', hash }); expect(sent).toHaveBeenCalledWith(hash, { kind: 'wrap', fixture: true })
  })
  it('marks a declined send rejected and a different signed block mismatched', async () => {
    const { z, ops } = await connectedPhone()
    await expect(z.sendBlock(spec())).rejects.toMatchObject({ name: 'AppHandoffError' })
    await answer('error', { code: 4001, message: 'User rejected the request.' })
    expect(ops.operations.entries.at(-1)!.state).toBe('rejected')
    await expect(z.sendBlock(spec())).rejects.toMatchObject({ name: 'AppHandoffError' })
    const template = JSON.parse(appDecode(opened().searchParams.get('params')!))
    await answer('result', { hash, block: { ...template, toAddress: account } })
    expect(ops.operations.entries.at(-1)).toMatchObject({ state: 'mismatch', reportedHashes: [hash] })
  })
  it('leaves an expired approval unknown, and drops the session the app no longer honours', async () => {
    const { z, ops } = await connectedPhone()
    await expect(z.sendBlock(spec())).rejects.toMatchObject({ name: 'AppHandoffError' })
    await answer('error', { code: -32603, message: 'Approval expired. The outcome is unknown; verify it before retrying.' })
    expect(ops.operations.entries.at(-1)!.state).toBe('unknown')
    z.checkSyriusNetwork(); await answer('error', { code: 4100, message: 'Unauthorized' })
    expect(z.syrius.address).toBeNull(); expect(storage.has('bridge.syrius.app')).toBe(false)
  })
  it('ignores an answer it did not ask for', async () => {
    const { z, t } = await phone(), a = await import('../../src/wallet/syriusApp.ts')
    z.applyAppAnswer({ id: 'forged', result: [account] })
    expect(z.syrius.address).toBeNull(); expect(t.toasts[0].text).toBe('Syrius answer expired'); expect(a.pendingRequests()).toEqual([])
  })
  it('restores the session in a tab the answer did not open', async () => {
    await connectedPhone()
    vi.resetModules()
    const { z } = await phone()
    expect(z.syrius).toMatchObject({ app: true, address: account, chainId: 1 })
  })
})

describe('user nodes', () => {
  const mine = 'wss://mine.fixture.invalid:35998'
  it('reads what a person types as a node address', async () => {
    const z = await import('../../src/state/zenon.ts')
    expect(z.normalizeNodeUrl(' https://mine.fixture.invalid:35998/ ')).toBe(mine)
    expect(z.normalizeNodeUrl('mine.fixture.invalid:35998')).toBe(mine)
    expect(z.normalizeNodeUrl('ws://127.0.0.1:35998')).toBe('ws://127.0.0.1:35998')
    for (const bad of ['', 'ftp://x', 'wss://u:p@x', 'wss://x/?a=1', 'wss://x/#h', 'two words']) expect(z.normalizeNodeUrl(bad)).toBeNull()
    expect(z.customNodeProblem('ws://node.fixture.invalid:35997')).toBe('Use wss:// for a remote node')
    expect(z.customNodeProblem('ws://localhost:35997')).toBe('')
    expect(z.customNodeProblem(null)).toBe('Not a node address')
  })
  it('asks before using a new node, then remembers it and its chain', async () => {
    const z = await import('../../src/state/zenon.ts'); await z.startNode()
    f.nodes[mine] = { frontier: async () => ({ chainIdentifier: 3, height: 3, timestamp: Date.now() / 1000 }) }
    await z.useCustomNode('mine.fixture.invalid:35998')
    expect(z.node.source).toBe('default'); expect(z.walletNode.pending).toEqual({ url: mine, chainId: 3, kind: 'custom' })
    z.confirmWalletNode()
    expect(z.node).toMatchObject({ source: 'custom', url: mine, chainId: 3 }); expect(z.customNodes.list).toEqual([{ url: mine, chainId: 3 }])
    z.useDefaultNode(); expect(z.node.source).toBe('default')
    await z.useCustomNode(mine)
    expect(z.walletNode.pending).toBeNull(); expect(z.node).toMatchObject({ source: 'custom', url: mine })
  })
  it('asks again when a listed node has moved to another chain', async () => {
    const z = await import('../../src/state/zenon.ts'); await z.startNode()
    let chain = 3
    f.nodes[mine] = { frontier: async () => ({ chainIdentifier: chain, height: 3, timestamp: Date.now() / 1000 }) }
    await z.useCustomNode(mine); z.confirmWalletNode(); z.useDefaultNode()
    chain = 1; await z.useCustomNode(mine)
    expect(z.node.source).toBe('default'); expect(z.walletNode.pending).toEqual({ url: mine, chainId: 1, kind: 'custom' })
  })
  it('says why a node cannot be used', async () => {
    const z = await import('../../src/state/zenon.ts'); await z.startNode()
    await z.useCustomNode('ws://remote.fixture.invalid:35997'); expect(z.customNodes.problem).toBe('Use wss:// for a remote node')
    f.nodes[mine] = { frontier: () => Promise.reject(new Error('offline')) }
    await z.useCustomNode(mine); expect(z.customNodes.problem).toBe('Node is unreachable'); expect(z.walletNode.pending).toBeNull()
  })
  it('starts on the chosen node, and falls back with a notice when it changed chain', async () => {
    let z = await import('../../src/state/zenon.ts'); await z.startNode()
    f.nodes[mine] = { frontier: async () => ({ chainIdentifier: 3, height: 3, timestamp: Date.now() / 1000 }) }
    await z.useCustomNode(mine); z.confirmWalletNode()
    vi.resetModules(); f.clients = []
    z = await import('../../src/state/zenon.ts'); await z.startNode()
    expect(z.node).toMatchObject({ source: 'custom', url: mine, chainId: 3 })
    vi.resetModules(); f.nodes[mine].frontier = async () => ({ chainIdentifier: 1, height: 3, timestamp: Date.now() / 1000 })
    const { config } = await import('../../src/config.ts'); config.defaultNodes = [defaultUrl]; config.defaultNode = defaultUrl
    z = await import('../../src/state/zenon.ts'); await z.startNode()
    expect(z.node).toMatchObject({ source: 'default', url: defaultUrl }); expect(z.node.notice).toBe('Your node changed chain. Reading from default.fixture.invalid.')
    expect(z.customNodes.list).toEqual([{ url: mine, chainId: 3 }])
  })
  it('goes back to the default when the node in use is removed', async () => {
    const z = await import('../../src/state/zenon.ts'); await z.startNode()
    f.nodes[mine] = { frontier: async () => ({ chainIdentifier: 1, height: 3, timestamp: Date.now() / 1000 }) }
    await z.useCustomNode(mine); z.confirmWalletNode(); expect(z.node.source).toBe('custom')
    z.removeCustomNode(mine)
    expect(z.node).toMatchObject({ source: 'default', url: defaultUrl }); expect(z.customNodes.list).toEqual([]); expect(storage.has('bridge.node.custom')).toBe(false)
  })
})
