// Swaps between EVM assets, on one chain or across two, through LI.FI's
// routing API (li.quest): the same aggregator Jumper and MetaMask's bridge
// route through. It picks a DEX for a same-chain swap and a third-party
// bridge for a cross-chain one, and answers with one transaction for the
// user's wallet to send.
//
// None of this touches the Zenon bridge or its orchestrators, which is the
// point: these routes keep working, in seconds, while the orchestrators are
// not signing.
//
// The API needs no key and sends `access-control-allow-origin: *`, so a
// static page can call it. Unkeyed it allows 75 quotes per two hours per
// address, which is why the page asks for a quote when an input changes and
// not on a timer.

export const NATIVE = '0x0000000000000000000000000000000000000000'

export interface SwapAsset {
  chainId: number
  /** NATIVE for the chain's own coin. */
  address: string
  symbol: string
  decimals: number
}

export interface SwapConfig {
  api: string
  /**
   * The contract every transaction and every approval must name. LI.FI
   * deploys its diamond at one address on every chain; a quote naming any
   * other is refused, so a wrong or tampered answer cannot point an approval
   * at a stranger.
   */
  spender: string
  chains: number[]
  /** Where a cross-chain transfer can be followed. */
  scan: string
}

export interface QuoteRequest {
  from: SwapAsset
  to: SwapAsset
  amount: bigint
  fromAddress: string
  toAddress: string
}

export interface Quote {
  request: QuoteRequest
  /** The DEX or bridge the route runs through. */
  tool: string
  toAmount: bigint
  toAmountMin: bigint
  /** Seconds after the sending transaction confirms. */
  seconds: number
  feeUsd: number
  tx: { to: `0x${string}`; data: `0x${string}`; value: bigint }
  at: number
}

export type QuoteResult = { ok: true; quote: Quote } | { ok: false; message: string }

export const isNative = (a: SwapAsset) => a.address.toLowerCase() === NATIVE
export const sameAsset = (a: SwapAsset | null, b: SwapAsset | null) =>
  !!a && !!b && a.chainId === b.chainId && a.address.toLowerCase() === b.address.toLowerCase()
export const assetKey = (a: SwapAsset) => `${a.chainId}:${a.address.toLowerCase()}`

export function quoteUrl(c: SwapConfig, q: QuoteRequest): string {
  const p = new URLSearchParams({
    fromChain: String(q.from.chainId),
    toChain: String(q.to.chainId),
    fromToken: q.from.address,
    toToken: q.to.address,
    fromAmount: q.amount.toString(),
    fromAddress: q.fromAddress,
    toAddress: q.toAddress,
  })
  return `${c.api}/quote?${p}`
}

const big = (v: unknown): bigint | null => {
  try {
    return typeof v === 'string' || typeof v === 'number' ? BigInt(v) : null
  } catch {
    return null
  }
}

/** Reads a quote, refusing one that is incomplete or names another contract. */
export function parseQuote(c: SwapConfig, request: QuoteRequest, body: any, now = Date.now()): QuoteResult {
  const e = body?.estimate
  const t = body?.transactionRequest
  const toAmount = big(e?.toAmount)
  const toAmountMin = big(e?.toAmountMin)
  if (!e || !t || toAmount === null || toAmountMin === null || typeof t.to !== 'string' || typeof t.data !== 'string') {
    return { ok: false, message: typeof body?.message === 'string' ? body.message : 'No route' }
  }
  const spender = c.spender.toLowerCase()
  if (t.to.toLowerCase() !== spender) return { ok: false, message: 'Quote names an unknown contract' }
  if (!isNative(request.from) && String(e.approvalAddress ?? '').toLowerCase() !== spender) {
    return { ok: false, message: 'Quote names an unknown contract' }
  }
  const value = big(t.value ?? '0') ?? 0n
  // The value sent is the amount for a native source and nothing otherwise.
  if (value !== (isNative(request.from) ? request.amount : 0n)) return { ok: false, message: 'Quote asks for another amount' }
  const feeUsd = (Array.isArray(e.feeCosts) ? e.feeCosts : []).reduce((s: number, f: any) => s + (Number(f?.amountUSD) || 0), 0)
  return {
    ok: true,
    quote: {
      request,
      tool: String(body.toolDetails?.name || body.tool || ''),
      toAmount,
      toAmountMin,
      seconds: Number(e.executionDuration) || 0,
      feeUsd,
      tx: { to: t.to as `0x${string}`, data: t.data as `0x${string}`, value },
      at: now,
    },
  }
}

export async function fetchQuote(c: SwapConfig, q: QuoteRequest, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<QuoteResult> {
  try {
    const res = await fetcher(quoteUrl(c, q), { headers: { Accept: 'application/json' }, signal })
    if (res.status === 429) return { ok: false, message: 'Too many quotes. Try again later.' }
    let body: any = null
    try {
      body = await res.json()
    } catch {
      /* empty body */
    }
    if (!res.ok) return { ok: false, message: res.status === 404 ? 'No route' : typeof body?.message === 'string' ? body.message : `HTTP ${res.status}` }
    return parseQuote(c, q, body)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export type SwapState = 'pending' | 'done' | 'failed'

/** Where a cross-chain transfer stands. An unknown hash is pending: the API learns of it late. */
export async function fetchStatus(c: SwapConfig, txHash: string, fromChain: number, toChain: number, fetcher: typeof fetch = fetch): Promise<SwapState> {
  try {
    const res = await fetcher(`${c.api}/status?${new URLSearchParams({ txHash, fromChain: String(fromChain), toChain: String(toChain) })}`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return 'pending'
    const s = (await res.json())?.status
    return s === 'DONE' ? 'done' : s === 'FAILED' ? 'failed' : 'pending'
  } catch {
    return 'pending'
  }
}

/** Time shown before a quote arrives, and added to one for the sending block. */
export function swapEstimate(from: SwapAsset, to: SwapAsset, sourceBlockSeconds: number, quote: Quote | null): number {
  const settle = quote ? quote.seconds : from.chainId === to.chainId ? 0 : 60
  return Math.ceil(sourceBlockSeconds + settle)
}

/** A quote older than this is asked for again before it is sent. */
export const QUOTE_TTL_MS = 60_000
