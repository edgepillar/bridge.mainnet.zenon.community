// JSON-RPC to a go-zenon node, over WebSocket when the URL is ws(s) and over
// HTTP otherwise.
//
// WebSocket is the default because it is what the public nodes and Syrius
// speak, it carries the momentum subscription, and a socket needs no CORS
// preflight (an HTTPS endpoint without CORS headers is unusable from a page).
// The socket reconnects with backoff and re-subscribes; calls made while it is
// down wait for it, up to their timeout.

export class RpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
    this.name = 'RpcError'
  }
  /** go-zenon's "no such entry": an answer, not a fault. */
  get isNotFound(): boolean {
    return /data non existent|not found/i.test(this.message)
  }
}

export interface Momentum {
  hash: string
  height: number
  timestamp: number
  chainIdentifier: number
  producer?: string
}

export interface RequiredPow {
  availablePlasma: number
  basePlasma: number
  requiredDifficulty: number
}

export type ConnectionState = 'connecting' | 'open' | 'closed'

/**
 * JSON.parse, with every integer of 16 or more digits kept as a string.
 *
 * Most go-zenon amounts are already strings, but not all: a liquidity stake's
 * `amount` and `weightedAmount` are bare `*big.Int`, and an 18-decimal LP
 * amount is far past 2^53. Parsed as a number it silently loses its low
 * digits, and a cancel or display built from it is wrong. The scan skips
 * string contents, so a number inside a metadata string is left alone.
 */
export function parseJsonSafe(raw: string): unknown {
  let out = ''
  let inString = false
  let i = 0
  while (i < raw.length) {
    const c = raw[i]
    if (inString) {
      out += c
      if (c === '\\') {
        out += raw[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i + 1
      while (j < raw.length && /[0-9.eE+-]/.test(raw[j])) j++
      const num = raw.slice(i, j)
      out += /^-?\d{16,}$/.test(num) ? `"${num}"` : num
      i = j
      continue
    }
    out += c
    i++
  }
  return JSON.parse(out)
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

const CALL_TIMEOUT_MS = 20_000

export class ZenonClient {
  readonly url: string
  private readonly ws: boolean
  private socket: WebSocket | null = null
  private id = 0
  private pending = new Map<number, Pending>()
  private waiting: Array<() => void> = []
  private momentumHandlers = new Set<(m: Momentum) => void>()
  private subscriptionId: string | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastPolled = 0
  private retry = 0
  private closed = false
  state: ConnectionState = 'connecting'
  onState?: (s: ConnectionState) => void

  constructor(url: string) {
    this.url = url
    this.ws = /^wss?:\/\//i.test(url)
    if (this.ws) this.open()
    else this.setState('open')
  }

  private setState(s: ConnectionState) {
    this.state = s
    this.onState?.(s)
  }

  private open() {
    if (this.closed) return
    this.setState('connecting')
    let socket: WebSocket
    try {
      socket = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.onopen = () => {
      this.retry = 0
      this.setState('open')
      const ready = this.waiting
      this.waiting = []
      for (const go of ready) go()
      if (this.momentumHandlers.size) void this.subscribe()
    }
    socket.onmessage = (ev) => this.onMessage(String(ev.data))
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.subscriptionId = null
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('connection to the node closed'))
      }
      this.pending.clear()
      this.setState('closed')
      this.scheduleReconnect()
    }
    socket.onerror = () => {
      /* onclose follows and handles it */
    }
  }

  private scheduleReconnect() {
    if (this.closed) return
    const wait = Math.min(15_000, 500 * 2 ** this.retry++)
    setTimeout(() => this.open(), wait)
  }

  private onMessage(raw: string) {
    let msg: {
      id?: number
      result?: unknown
      error?: { code: number; message: string }
      method?: string
      params?: { subscription: string; result: unknown }
    }
    try {
      msg = parseJsonSafe(raw) as typeof msg
    } catch {
      return
    }
    if (msg.method && msg.params) {
      if (msg.params.subscription === this.subscriptionId) {
        const list = Array.isArray(msg.params.result) ? msg.params.result : [msg.params.result]
        for (const m of list as Momentum[]) this.emitMomentum(m)
      }
      return
    }
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message))
    else p.resolve(msg.result)
  }

  private emitMomentum(m: Momentum) {
    for (const h of this.momentumHandlers) h(m)
  }

  private whenOpen(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.url} did not answer`)), CALL_TIMEOUT_MS)
      this.waiting.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const n = ++this.id
    if (!this.ws) return this.httpCall<T>(n, method, params)
    await this.whenOpen()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(n)
        reject(new Error(`${method}: no answer within ${CALL_TIMEOUT_MS / 1000} s`))
      }, CALL_TIMEOUT_MS)
      this.pending.set(n, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.socket!.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }))
    })
  }

  private async httpCall<T>(n: number, method: string, params: unknown[]): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS)
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: n, method, params }),
        signal: ctrl.signal,
      })
      const body = parseJsonSafe(await res.text()) as { result?: T; error?: { code: number; message: string } }
      if (body.error) throw new RpcError(body.error.code, body.error.message)
      return body.result as T
    } finally {
      clearTimeout(timer)
    }
  }

  /** `null` instead of a throw when the node says the entry does not exist. */
  async callOrNull<T>(method: string, params: unknown[] = []): Promise<T | null> {
    try {
      return await this.call<T>(method, params)
    } catch (err) {
      if (err instanceof RpcError && err.isNotFound) return null
      throw err
    }
  }

  /**
   * Every new momentum. Over a socket this is `ledger.subscribe('momentums')`;
   * over HTTP the frontier is polled every 5 s.
   */
  onMomentum(handler: (m: Momentum) => void): () => void {
    this.momentumHandlers.add(handler)
    if (this.momentumHandlers.size === 1) {
      if (this.ws) void this.subscribe()
      else this.startPolling()
    }
    return () => {
      this.momentumHandlers.delete(handler)
      if (!this.momentumHandlers.size && this.pollTimer) {
        clearInterval(this.pollTimer)
        this.pollTimer = null
      }
    }
  }

  private async subscribe() {
    try {
      this.subscriptionId = await this.call<string>('ledger.subscribe', ['momentums'])
    } catch {
      // Some proxies refuse subscriptions; polling covers them.
      this.startPolling()
    }
  }

  private startPolling() {
    if (this.pollTimer) return
    const tick = async () => {
      try {
        const m = await this.call<Momentum>('ledger.getFrontierMomentum')
        if (m.height > this.lastPolled) {
          this.lastPolled = m.height
          this.emitMomentum(m)
        }
      } catch {
        /* the next tick tries again */
      }
    }
    void tick()
    this.pollTimer = setInterval(tick, 5000)
  }

  close() {
    this.closed = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    // Calls in flight fail now rather than at their timeout: the caller is
    // usually about to ask the replacement client the same thing.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('connection to the node closed'))
    }
    this.pending.clear()
    this.socket?.close()
    this.socket = null
  }

  // Calls the e2e harness's signer needs (e2e/lib/publish.ts).

  frontierMomentum(): Promise<Momentum> {
    return this.call('ledger.getFrontierMomentum')
  }

  frontierAccountBlock(address: string): Promise<{ hash: string; height: number } | null> {
    return this.callOrNull('ledger.getFrontierAccountBlock', [address])
  }

  requiredPow(address: string, blockType: number, toAddress: string, dataBase64: string): Promise<RequiredPow> {
    return this.call('embedded.plasma.getRequiredPoWForAccountBlock', [{ address, blockType, toAddress, data: dataBase64 }])
  }

  publish(block: unknown): Promise<null> {
    return this.call('ledger.publishRawTransaction', [block])
  }
}
