// The Zenon side: which node the page reads from, the live momentum, and the
// Syrius wallet.
//
// The page reads from the configured default node. The node Syrius reports,
// or a node the user adds, is used only when the user picks it and confirms
// the network the node says it is on (its chain identifier), because that
// node decides everything the page shows: a devnet node shows that devnet's
// bridge. The choice is remembered with the chain identifier it was confirmed
// for, and dropped when either changes.
//
// Nothing here is tied to chain 1. The bridge's networks, contracts and token
// pairs are read from the embedded bridge contract of whichever chain the node
// is on, and blocks are built for that chain.
//
// Since v0.3.4 Syrius reports only `ws://host:port`. A node the page cannot
// use is refused with the reason:
//
//   - "embedded" or none: the wallet's internal node has no address.
//   - ws:// from an https page: the browser blocks mixed content. A node on
//     127.0.0.1 or localhost is the exception browsers make, and it is the
//     user's own machine, so a local devnet works from the deployed page.
//   - unreachable within 5 s.

import { reactive, shallowRef, watch } from 'vue'
import { config, setActiveChain, zenonNetworkName } from '../config.ts'
import { ZenonClient, type Momentum } from '../znn/client.ts'
import { ZenonApi } from '../znn/api.ts'
import { blockTemplate, type BlockSpec } from '../znn/block.ts'
import { isUserAddress } from '../znn/primitives.ts'
import * as syriusWallet from '../wallet/syrius.ts'
import * as syriusApp from '../wallet/syriusApp.ts'
import { NotSubmittedError } from '../core/errors.ts'
import { journalSubmission, operations, updateOperation } from './operations.ts'
import { toast, toastError } from './toasts.ts'

export const node = reactive({
  url: config.defaultNode,
  source: 'default' as 'default' | 'wallet' | 'custom',
  /** The chain identifier the node reports; 0 until it has answered. */
  chainId: 0,
  notice: '',
  conn: 'connecting' as 'connecting' | 'open' | 'closed',
  height: 0,
  timestamp: 0,
  /** Seconds per momentum, measured over the recent ones. */
  rate: 10,
  /** Bumped on every momentum, for anything that refreshes on the chain's beat. */
  tick: 0,
  /** Invalidates all reads and operation drafts when the selected client changes. */
  epoch: 0,
})

watch(() => node.chainId, setActiveChain)

/** The chain the page is on: the node's, or the build's until it answers. */
export const chainId = () => node.chainId || config.zenonChainId
export const networkLabel = () => zenonNetworkName(chainId())
/** The explorers, the plasma bot and the liquidity pool belong to the build's chain only. */
export const onBuildChain = () => chainId() === config.zenonChainId

export const api = shallowRef<ZenonApi>(null as unknown as ZenonApi)
let client: ZenonClient | null = null
let stopMomentums: (() => void) | null = null
const recent: number[] = []

function attach(c: ZenonClient, knownChainId = 0) {
  node.epoch++
  stopMomentums?.()
  const previous = client
  client = c
  previous?.close()
  api.value = new ZenonApi(c)
  const selectedApi = api.value
  node.url = c.url
  node.conn = c.state
  recent.length = 0
  // Another node may be on another chain, with a lower height.
  node.height = 0
  node.timestamp = 0
  node.chainId = knownChainId
  let transport = 0
  let refreshing: number | null = null
  let validated = !!knownChainId && c.state === 'open'
  let establishedChain = knownChainId
  if (!validated) node.chainId = 0
  const current = (generation: number) => client === c && transport === generation && validated
  const refresh = async () => {
    const generation = transport
    if (refreshing === generation) return
    refreshing = generation
    try {
      const m = await c.frontierMomentum()
      if (client !== c || generation !== transport) return
      if (node.source !== 'default' && establishedChain && m.chainIdentifier !== establishedChain) {
        const custom = node.source === 'custom'
        if (custom) writeSelected(null)
        else writePref(null)
        useDefault(`${custom ? 'Your node' : 'Syrius node'} changed chain. Reading from ${hostOf(config.defaultNode)}.`)
        return
      }
      node.chainId = m.chainIdentifier
      establishedChain = m.chainIdentifier
      validated = true
      onMomentum(m, c, selectedApi, () => current(generation))
      void seedMomentums(c, selectedApi, () => current(generation))
    } catch { /* A new socket alone cannot restore chain or signing authority. */ }
    finally { if (refreshing === generation) refreshing = null }
  }
  c.onState = (s) => {
    if (client !== c) return
    node.conn = s
    if (s === 'closed') {
      // The client object survives reconnects; every asynchronous read must
      // still belong to the socket whose chain identity was established.
      transport++
      validated = false
      node.epoch++
      node.chainId = node.height = node.timestamp = 0
      recent.length = 0
      node.rate = 10
    } else if (s === 'open') void refresh()
  }
  stopMomentums = c.onMomentum((m) => {
    if (client !== c) return
    if (!validated) {
      if (node.conn === 'open') void refresh()
      return
    }
    const generation = transport
    onMomentum(m, c, selectedApi, () => current(generation))
  })
  if (validated) void seedMomentums(c, selectedApi, () => current(0))
  else if (c.state === 'open') void refresh()
}

function onMomentum(m: Momentum, owner: ZenonClient, selectedApi: ZenonApi, current: () => boolean) {
  if (client !== owner || !current()) return
  if (m.chainIdentifier && m.chainIdentifier !== node.chainId) return
  if (m.height <= node.height) return
  // A subscription event carries only hash and height (go-zenon
  // rpc/api/subscribe/api.go), so the timestamp is read once per momentum.
  if (!m.timestamp) {
    void selectedApi
      .momentumAt(m.height)
      .then((full) => full && onMomentum(full, owner, selectedApi, current))
      .catch(() => undefined)
    return
  }
  node.height = m.height
  node.timestamp = m.timestamp
  recent.push(m.timestamp)
  if (recent.length > 30) recent.shift()
  if (recent.length > 2) node.rate = (recent[recent.length - 1] - recent[0]) / (recent.length - 1)
  node.tick++
}

async function seedMomentums(owner: ZenonClient, selectedApi: ZenonApi, current: () => boolean) {
  try {
    const list = await selectedApi.momentums(30)
    if (client !== owner || !current() || !list.length || list.some((m) => m.chainIdentifier && m.chainIdentifier !== node.chainId)) return
    const top = list.reduce((a, b) => (b.height > a.height ? b : a), list[0])
    // A subscription may already be ahead of this asynchronous seed. Never
    // replace its samples, and let onMomentum append the top sample only once.
    if (top.height <= node.height) return
    const ts = list.filter((m) => m.height < top.height).map((m) => m.timestamp).sort((a, b) => a - b)
    recent.splice(0, recent.length, ...ts.slice(-29))
    onMomentum(top, owner, selectedApi, current)
  } catch {
    /* the subscription fills it in */
  }
}

/**
 * Opens the user's own node when one was chosen and it is still on the chain
 * it was confirmed for; otherwise the first default node that answers within
 * 5 s, in config order.
 */
export async function startNode() {
  const selected = readSelected()
  let fallback = ''
  if (selected) {
    try {
      const { probe, chainId } = await probeNode(selected.url)
      if (chainId === selected.chainId && !client) {
        node.source = 'custom'
        attach(probe, chainId)
        return
      }
      probe.close()
      if (chainId !== selected.chainId) {
        writeSelected(null)
        fallback = 'Your node changed chain.'
      }
    } catch {
      fallback = 'Your node is unreachable.'
    }
  }
  try { await startDefault() } finally {
    if (fallback && node.source === 'default') node.notice = `${fallback} Reading from ${hostOf(config.defaultNode)}.`
  }
}

async function startDefault() {
  for (const url of config.defaultNodes) {
    const c = new ZenonClient(url)
    try {
      const m = await Promise.race([c.frontierMomentum(), new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 5000))])
      config.defaultNode = url
      // A remembered wallet node may have been restored first. Keep that one;
      // otherwise this is the page's connection.
      if (client && node.source !== 'default') c.close()
      else attach(c, m.chainIdentifier)
      return
    } catch {
      c.close()
    }
  }
  // None answered: keep the first and let the client keep retrying.
  if (!client) attach(new ZenonClient(config.defaultNodes[0]))
}

/** Why the wallet's node cannot be used from this page, or '' if it can be tried. */
export function nodeProblem(url: string | null): string {
  if (!url || url === 'embedded' || !/^(wss?|https?):\/\//i.test(url)) return 'Syrius uses its embedded node'
  let u: URL
  try { u = new URL(url.replace(/^http/i, 'ws')) } catch { return 'Syrius node address is invalid' }
  if (!u.hostname || u.username || u.password || u.hash || url.length > 2048) return 'Syrius node address is invalid'
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (location.protocol === 'https:' && u.protocol === 'ws:' && !local) return 'Syrius node is not secure (ws)'
  return ''
}

const PREF_KEY = 'bridge.node'
const NODES_KEY = 'bridge.nodes'
const SELECTED_KEY = 'bridge.node.custom'
const MAX_NODES = 8

interface NodePref {
  url: string
  chainId: number
}

/**
 * A node address typed by the user, as the client wants it: `wss://host` or
 * `ws://host:port`, with `https://` and `http://` read as those, and a bare
 * host read as wss. Null when it is not an address at all.
 */
export function normalizeNodeUrl(text: string): string | null {
  const t = text.trim()
  if (!t || t.length > 2048 || /\s/.test(t)) return null
  let u: URL
  try { u = new URL(/^[a-z][a-z0-9+.-]*:[/]{2}/i.test(t) ? t : `wss://${t}`) } catch { return null }
  const scheme = { 'https:': 'wss:', 'http:': 'ws:', 'wss:': 'wss:', 'ws:': 'ws:' }[u.protocol]
  if (!scheme || !u.hostname || u.username || u.password || u.search || u.hash) return null
  return `${scheme}//${u.host}${u.pathname === '/' ? '' : u.pathname}`
}

/**
 * Why the page cannot read from a node the user typed, or '' if it can try.
 * The CSP (index.html) admits wss to any host and ws only to this machine,
 * which is also the one exception browsers make to mixed content.
 */
export function customNodeProblem(url: string | null): string {
  if (!url) return 'Not a node address'
  const u = new URL(url)
  if (u.protocol === 'ws:' && !['localhost', '127.0.0.1'].includes(u.hostname)) return 'Use wss:// for a remote node'
  return ''
}

function validPref(p: unknown): p is NodePref {
  const r = p as NodePref
  return !!r && typeof r.url === 'string' && normalizeNodeUrl(r.url) === r.url && !customNodeProblem(r.url) && Number.isSafeInteger(r.chainId) && r.chainId > 0
}

function readNodes(): NodePref[] {
  try {
    const list = JSON.parse(localStorage.getItem(NODES_KEY) ?? '[]') as unknown
    return Array.isArray(list) ? list.filter(validPref).slice(0, MAX_NODES).map((p) => ({ url: p.url, chainId: p.chainId })) : []
  } catch {
    return []
  }
}

function writeNodes(list: NodePref[]) {
  try {
    if (list.length) localStorage.setItem(NODES_KEY, JSON.stringify(list))
    else localStorage.removeItem(NODES_KEY)
  } catch {
    /* storage blocked: the list lasts for this visit */
  }
}

function readSelected(): NodePref | null {
  try {
    const p = JSON.parse(localStorage.getItem(SELECTED_KEY) ?? 'null') as unknown
    return validPref(p) ? { url: p.url, chainId: p.chainId } : null
  } catch {
    return null
  }
}

function writeSelected(p: NodePref | null) {
  try {
    if (p) localStorage.setItem(SELECTED_KEY, JSON.stringify({ url: p.url, chainId: p.chainId }))
    else localStorage.removeItem(SELECTED_KEY)
  } catch {
    /* storage blocked: the choice lasts for this visit */
  }
}

/** Nodes the user added, each with the chain it was confirmed on. */
export const customNodes = reactive({
  list: readNodes(),
  problem: '',
})

function readPref(): NodePref | null {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? 'null') as NodePref | null
    return p && typeof p.url === 'string' && !nodeProblem(p.url) && Number.isSafeInteger(p.chainId) && p.chainId > 0 ? p : null
  } catch {
    return null
  }
}

function writePref(p: NodePref | null) {
  try {
    if (p) localStorage.setItem(PREF_KEY, JSON.stringify(p))
    else localStorage.removeItem(PREF_KEY)
  } catch {
    /* storage blocked: the choice lasts for this visit */
  }
}

/** The switch to the wallet's node or a user's node, and the confirmation it waits on. */
export const walletNode = reactive({
  checking: false,
  problem: '',
  /** Probed and waiting for the user to confirm its network. */
  pending: null as (NodePref & { kind: 'wallet' | 'custom' }) | null,
})
let pendingProbe: ZenonClient | null = null
let probeEpoch = 0
let walletEpoch = 0
let walletConnectionWanted = true

const wsUrlOf = (url: string) => url.replace(/^http/i, 'ws')

async function probeNode(url: string): Promise<{ probe: ZenonClient; chainId: number }> {
  const probe = new ZenonClient(url)
  try {
    const m = await Promise.race([
      probe.frontierMomentum(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ])
    return { probe, chainId: m.chainIdentifier }
  } catch (err) {
    probe.close()
    throw err
  }
}

function useDefault(notice = '') {
  node.notice = notice
  if (node.source === 'default') return
  node.source = 'default'
  attach(new ZenonClient(config.defaultNode))
}

/** Asks the wallet's node which chain it is on, then waits for confirmWalletNode. */
export async function requestWalletNode() {
  cancelWalletNode()
  const request = probeEpoch, account = syrius.address, walletUrl = syrius.nodeUrl
  walletNode.problem = nodeProblem(syrius.nodeUrl)
  if (walletNode.problem) return
  const url = wsUrlOf(syrius.nodeUrl!)
  walletNode.checking = true
  try {
    const { probe, chainId } = await probeNode(url)
    if (request !== probeEpoch || account !== syrius.address || walletUrl !== syrius.nodeUrl) { probe.close(); return }
    pendingProbe = probe
    walletNode.pending = { url, chainId, kind: 'wallet' }
  } catch {
    if (request === probeEpoch) walletNode.problem = 'Syrius node is unreachable'
  } finally {
    if (request === probeEpoch) walletNode.checking = false
  }
}

/**
 * Asks a node the user typed, or picked from their list, which chain it is
 * on. A listed node still on the chain it was confirmed for is used at once;
 * anything else waits for confirmWalletNode.
 */
export async function useCustomNode(text: string) {
  cancelWalletNode()
  customNodes.problem = ''
  const url = normalizeNodeUrl(text)
  customNodes.problem = customNodeProblem(url)
  if (customNodes.problem) return
  const request = probeEpoch
  walletNode.checking = true
  try {
    const { probe, chainId } = await probeNode(url!)
    if (request !== probeEpoch) { probe.close(); return }
    pendingProbe = probe
    walletNode.pending = { url: url!, chainId, kind: 'custom' }
    if (customNodes.list.some((n) => n.url === url && n.chainId === chainId)) confirmWalletNode()
  } catch {
    if (request === probeEpoch) customNodes.problem = 'Node is unreachable'
  } finally {
    if (request === probeEpoch) walletNode.checking = false
  }
}

export function removeCustomNode(url: string) {
  customNodes.list = customNodes.list.filter((n) => n.url !== url)
  writeNodes(customNodes.list)
  if (readSelected()?.url === url) writeSelected(null)
  if (node.source === 'custom' && node.url === url) useDefault()
}

export function confirmWalletNode() {
  const p = walletNode.pending
  if (!p || !pendingProbe) return
  // The page may already be on that very node (Syrius set to the default).
  if (client && client.url === p.url && node.chainId === p.chainId && nodeIsCurrent()) {
    pendingProbe.close()
    node.chainId = p.chainId
  } else attach(pendingProbe, p.chainId)
  pendingProbe = null
  walletNode.pending = null
  node.source = p.kind
  node.notice = ''
  const pref = { url: p.url, chainId: p.chainId }
  // One choice at a time: the wallet's node or the user's own.
  if (p.kind === 'custom') {
    customNodes.list = [pref, ...customNodes.list.filter((n) => n.url !== p.url)].slice(0, MAX_NODES)
    writeNodes(customNodes.list)
    writeSelected(pref)
    writePref(null)
  } else {
    writeSelected(null)
    writePref(pref)
  }
}

export function cancelWalletNode() {
  probeEpoch++
  walletNode.checking = false
  pendingProbe?.close()
  pendingProbe = null
  walletNode.pending = null
}

export function useDefaultNode() {
  cancelWalletNode()
  walletNode.problem = ''
  customNodes.problem = ''
  writePref(null)
  writeSelected(null)
  useDefault()
}

/**
 * Called whenever Syrius reports its state. Restores a confirmed choice when
 * the wallet still names the same node and that node is still on the same
 * chain; anything else goes back to the default node and says so.
 */
async function syncWalletNode(url: string | null, request: number) {
  walletNode.problem = ''
  const pref = readPref()
  if (!pref) return node.source === 'wallet' ? useDefault() : undefined
  const back = `Reading from ${hostOf(config.defaultNode)}.`
  if (nodeProblem(url) || wsUrlOf(url!) !== pref.url) {
    writePref(null)
    return useDefault(node.source === 'wallet' ? `Syrius changed its node. ${back}` : '')
  }
  if (node.source === 'wallet' && client?.url === pref.url) return
  try {
    const { probe, chainId } = await probeNode(pref.url)
    if (request !== walletEpoch || syrius.nodeUrl !== url || !syrius.address) { probe.close(); return }
    if (chainId !== pref.chainId) {
      probe.close()
      writePref(null)
      return useDefault(`Syrius node changed chain. ${back}`)
    }
    if (client && client.url === pref.url && node.chainId === chainId && nodeIsCurrent()) {
      probe.close()
      node.chainId = chainId
    } else attach(probe, chainId)
    node.source = 'wallet'
    node.notice = ''
  } catch {
    if (request === walletEpoch) useDefault(`Syrius node is unreachable. ${back}`)
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// Syrius

export const syrius = reactive({
  /** The extension, any version. */
  present: false,
  /** No extension on a phone: the Syrius app, reached by links (syriusApp.ts). */
  app: false,
  address: null as string | null,
  chainId: null as number | null,
  nodeUrl: null as string | null,
  busy: false,
  hold: 0,
})

export const wrongZenonChain = () => syrius.address !== null && (syrius.chainId === null || node.chainId === 0 || syrius.chainId !== node.chainId)
export const zenonChainMismatch = () => syrius.address !== null && syrius.chainId !== null && node.chainId !== 0 && syrius.chainId !== node.chainId

async function applyWalletState(s: syriusWallet.WalletState, request: number) {
  if (request !== walletEpoch) return
  cancelWalletNode()
  syrius.present = s.present
  syrius.address = s.address
  syrius.chainId = s.chainId
  syrius.nodeUrl = s.nodeUrl
  if (s.address) await syncWalletNode(s.nodeUrl, request)
  else if (node.source === 'wallet') useDefault()
}

export async function detectSyrius() {
  const answer = syriusApp.takeAnswerFromUrl()
  if (answer) applyAppAnswer(answer)
  const request = walletEpoch
  syrius.present = await syriusWallet.whenProviderReady()
  if (request !== walletEpoch) return
  if (!syrius.present) {
    syrius.app = syriusApp.isPhone()
    if (!syrius.app) return
    setAppSession(syriusApp.readSession())
    // Another tab may be the one the app's answer opened.
    window.addEventListener('storage', (event) => {
      if (event.key === syriusApp.SESSION_KEY && walletConnectionWanted) setAppSession(syriusApp.readSession())
    })
    return
  }
  // An origin approved earlier answers without a prompt; a new one answers empty.
  try {
    const s = await syriusWallet.readState()
    if (s.address) await applyWalletState(s, request)
  } catch {
    /* not connected yet */
  }
  syriusWallet.onWalletChange(async () => {
    if (!walletConnectionWanted) return
    const event = ++walletEpoch
    try { await applyWalletState(await syriusWallet.readState(), event) } catch { /* current connection remains unavailable */ }
  })
}

export async function connectSyrius() {
  walletConnectionWanted = true
  if (syrius.app) {
    syriusApp.openRequest('znn_connect', [])
    throw new syriusApp.AppHandoffError()
  }
  const request = ++walletEpoch
  syrius.busy = true
  try {
    await applyWalletState(await syriusWallet.connect({ onHold: (s) => (syrius.hold = s) }), request)
  } finally {
    if (request === walletEpoch) { syrius.busy = false; syrius.hold = 0 }
  }
}

/** Where Syrius is published: the extension for each browser and the phone app. */
export const SYRIUS_RELEASES = 'https://github.com/sol-znn/syrius-extension/releases'

/** The app's chain, asked once after connecting: a link carries one method. */
export function checkSyriusNetwork() {
  if (!syrius.app || !syrius.address) return
  syriusApp.openRequest('znn_chainId', [])
}

function setAppSession(s: syriusApp.AppSession | null) {
  syrius.address = s?.address ?? null
  syrius.chainId = s?.chainId ?? null
  syrius.nodeUrl = null
}

const appSent: ((hash: string, record: Record<string, unknown>) => void)[] = []
/** Called with the record a send asked for, once the app has answered with its hash. */
export function onAppSent(handler: (hash: string, record: Record<string, unknown>) => void) {
  appSent.push(handler)
}

/** Nothing was shown or signed: the app refused before any approval. */
const APP_REFUSALS = [4001, 4100, -32602, -32005, -32006]

/** An answer the app opened this page with. Unknown ids are someone else's, or expired. */
export function applyAppAnswer(answer: syriusApp.AppAnswer) {
  const pending = syriusApp.takePending(answer.id)
  if (!pending) return toast('Syrius answer expired', 'dim')
  const code = answer.error?.code
  const failed = answer.error ? new syriusWallet.WalletError(code!, answer.error.message || 'Syrius failed without saying why') : null
  if (code === 4100) {
    syriusApp.writeSession(null)
    setAppSession(null)
  }
  const session = syriusApp.readSession()
  if (pending.method === 'znn_connect') {
    const list = answer.result
    const address = Array.isArray(list) && typeof list[0] === 'string' && isUserAddress(list[0]) ? list[0] : null
    if (failed || !address) return toastError(failed ?? new Error('Syrius did not connect'))
    const next = { address, chainId: session?.address === address ? session.chainId : null }
    syriusApp.writeSession(next)
    setAppSession(next)
    return toast('Syrius connected', 'ok')
  }
  if (pending.method === 'znn_chainId') {
    const id = Number(answer.result)
    if (failed) return toastError(failed)
    // Not connected, as far as the app knows: it answers null.
    if (!session || answer.result === null || !Number.isSafeInteger(id) || id <= 0) {
      syriusApp.writeSession(null)
      setAppSession(null)
      return toast('Reconnect your wallet', 'warn')
    }
    const next = { address: session.address, chainId: id }
    syriusApp.writeSession(next)
    setAppSession(next)
    return toast(id === chainId() ? 'Network checked' : 'Syrius is on another chain', id === chainId() ? 'ok' : 'warn')
  }
  const record = operations.entries.find((r) => r.id === pending.operationId)
  if (!record || !pending.template) return toast('Send not found. Reload.', 'warn')
  if (failed) {
    if (APP_REFUSALS.includes(code!) && record.state === 'unknown' && !record.hash) updateOperation(record.id, { state: 'rejected' })
    return toastError(failed)
  }
  const result = answer.result as syriusWallet.SendAccountBlockResult | null
  const block = result?.block ?? result?.signedTransaction ?? null
  try {
    const sent = syriusWallet.checkedResult(pending.template, result?.hash ?? block?.hash, block, pending.account)
    updateOperation(record.id, { state: 'submitted', hash: sent.hash })
    if (pending.record) for (const h of appSent) h(sent.hash, pending.record)
    toast('Sent', 'wait', { href: onBuildChain() ? config.zenonExplorerTx(sent.hash) : '', label: 'View' })
  } catch (err) {
    const reported = err instanceof syriusWallet.WalletOutcomeError ? err.reportedHash : undefined
    try {
      if (reported) updateOperation(record.id, { state: 'mismatch', hash: reported, reportedHashes: [reported] })
    } catch { /* the record keeps what it had; Activity shows it */ }
    toastError(err)
  }
}

export async function disconnectSyrius() {
  walletConnectionWanted = false
  walletEpoch++
  syrius.address = null
  syrius.chainId = null
  syrius.nodeUrl = null
  syrius.busy = false
  syrius.hold = 0
  cancelWalletNode()
  walletNode.problem = ''
  // The choice is kept: the same wallet on the same node and chain restores it.
  if (node.source === 'wallet') useDefault()
  if (syrius.app) return syriusApp.writeSession(null)
  try { await syriusWallet.disconnect() } catch { /* local disconnect is authoritative */ }
}

/**
 * Hands a block to Syrius to sign and publish. Resolves with its hash. The
 * phone app answers by opening the page again, so there the call ends with
 * AppHandoffError and `record` is what is remembered when the answer comes.
 */
export async function sendBlock(spec: BlockSpec, beforePrompt: () => void = () => {}, record?: Record<string, unknown>): Promise<string> {
  if (!syrius.address) throw new Error('Connect Syrius first')
  if (syrius.app && syrius.chainId === null) throw new NotSubmittedError('Check network first')
  if (wrongZenonChain()) throw new Error(`Syrius is on chain ${syrius.chainId}, the page on chain ${chainId()}`)
  const account = syrius.address, selectedChain = node.chainId, epoch = node.epoch, selectedApi = api.value
  if (!selectedChain || !nodeIsCurrent() || !selectedApi) throw new Error('Node identity or freshness is unavailable')
  const template = blockTemplate(spec, selectedChain)
  const payload = JSON.stringify({ toAddress: template.toAddress, amount: template.amount, tokenStandard: template.tokenStandard, data: template.data, fromBlockHash: template.fromBlockHash, blockType: template.blockType })
  const guard = () => {
    beforePrompt()
    if (syrius.address !== account || syrius.chainId !== selectedChain || node.chainId !== selectedChain || node.epoch !== epoch || api.value !== selectedApi || !nodeIsCurrent()) throw new Error('Wallet or node changed. The original operation was not replaced.')
  }
  syrius.busy = true
  try {
    const result = await journalSubmission({ source: 'zenon', chainId: selectedChain, account, kind: 'zenon-send', payload }, guard, async (operationId) => {
      if (syrius.app) {
        syriusApp.openRequest('znn_signAndSendBlock', template, { operationId, template, account, record })
        throw new syriusApp.AppHandoffError()
      }
      const sent = await syriusWallet.sendAccountBlock(template, { onHold: (s) => (syrius.hold = s), beforePrompt: guard, account })
      return sent.hash
    })
    return result.hash
  } finally {
    syrius.busy = false
    syrius.hold = 0
  }
}

export function nodeIsCurrent() {
  const age = Date.now() / 1000 - node.timestamp
  return node.conn === 'open' && !!node.chainId && !!node.timestamp && age <= 120 && age >= -60
}
