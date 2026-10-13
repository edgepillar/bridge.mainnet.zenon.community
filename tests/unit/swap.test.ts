import { describe, expect, it, vi } from 'vitest'
import { NATIVE, fetchQuote, fetchStatus, isNative, parseQuote, quoteUrl, sameAsset, swapEstimate, type QuoteRequest, type SwapConfig } from '../../src/core/swap.ts'

const cfg: SwapConfig = { api: 'https://li.quest/v1', spender: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', chains: [1, 56], scan: 'https://scan.li.fi/tx/' }
const eth = { chainId: 1, address: NATIVE, symbol: 'ETH', decimals: 18 }
const bnb = { chainId: 56, address: NATIVE, symbol: 'BNB', decimals: 18 }
const wznn = { chainId: 1, address: '0xb2e96a63479C2Edd2FD62b382c89D5CA79f572d3', symbol: 'wZNN', decimals: 8 }
const me = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const them = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const req = (o: Partial<QuoteRequest> = {}): QuoteRequest => ({ from: eth, to: wznn, amount: 10n ** 17n, fromAddress: me, toAddress: me, ...o })

// The shape li.quest answered with on 2026-10-13, cut to what the page reads.
const body = (o: { to?: string; approval?: string; value?: string } = {}) => ({
  tool: 'nordstern',
  toolDetails: { name: 'Nordstern' },
  estimate: {
    toAmount: '156485717422',
    toAmountMin: '145483676087',
    executionDuration: 36,
    approvalAddress: o.approval ?? cfg.spender,
    feeCosts: [{ name: 'LIFI Fixed Fee', amountUSD: '0.6162' }, { name: 'CrossChain Fee', amountUSD: '1.2321' }],
  },
  transactionRequest: { to: o.to ?? cfg.spender, data: '0xabcdef', value: o.value ?? '0x16345785d8a0000', gasLimit: '0x1b7446' },
})

describe('swap', () => {
  it('asks for a quote with the recipient as toAddress', () => {
    const u = new URL(quoteUrl(cfg, req({ to: bnb, toAddress: them })))
    expect(u.origin + u.pathname).toBe('https://li.quest/v1/quote')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      fromChain: '1',
      toChain: '56',
      fromToken: NATIVE,
      toToken: NATIVE,
      fromAmount: '100000000000000000',
      fromAddress: me,
      toAddress: them,
    })
  })
  it('reads the amounts, the tool, the time and the summed fees', () => {
    const r = parseQuote(cfg, req(), body(), 5)
    expect(r).toMatchObject({ ok: true, quote: { tool: 'Nordstern', toAmount: 156485717422n, toAmountMin: 145483676087n, seconds: 36, at: 5 } })
    if (!r.ok) throw new Error('unreachable')
    expect(r.quote.feeUsd).toBeCloseTo(1.8483)
    expect(r.quote.tx).toEqual({ to: cfg.spender, data: '0xabcdef', value: 10n ** 17n })
  })
  it('refuses a transaction to any contract but the router', () => {
    expect(parseQuote(cfg, req(), body({ to: them }))).toEqual({ ok: false, message: 'Quote names an unknown contract' })
  })
  it('refuses an approval to any contract but the router', () => {
    const r = req({ from: wznn, to: eth, amount: 100n })
    expect(parseQuote(cfg, r, body({ approval: them, value: '0x0' }))).toEqual({ ok: false, message: 'Quote names an unknown contract' })
    expect(parseQuote(cfg, r, body({ value: '0x0' })).ok).toBe(true)
  })
  it('refuses a value other than the amount, and any value for a token', () => {
    expect(parseQuote(cfg, req(), body({ value: '0x2386f26fc10000000' }))).toEqual({ ok: false, message: 'Quote asks for another amount' })
    expect(parseQuote(cfg, req({ from: wznn, to: eth, amount: 100n }), body())).toEqual({ ok: false, message: 'Quote asks for another amount' })
  })
  it('says no route for an answer with no transaction, and passes on the API message', () => {
    expect(parseQuote(cfg, req(), {})).toEqual({ ok: false, message: 'No route' })
    expect(parseQuote(cfg, req(), { message: 'No available quotes' })).toEqual({ ok: false, message: 'No available quotes' })
  })
  it('fetches a quote, and names the rate limit and a missing route', async () => {
    const ok = vi.fn(async (_url: string) => new Response(JSON.stringify(body()), { status: 200 }))
    expect((await fetchQuote(cfg, req(), ok as unknown as typeof fetch)).ok).toBe(true)
    expect(String(ok.mock.calls[0][0])).toContain('/quote?fromChain=1')
    const limited = vi.fn(async () => new Response('', { status: 429 }))
    expect(await fetchQuote(cfg, req(), limited as unknown as typeof fetch)).toEqual({ ok: false, message: 'Too many quotes. Try again later.' })
    const none = vi.fn(async () => new Response(JSON.stringify({ message: 'x' }), { status: 404 }))
    expect(await fetchQuote(cfg, req(), none as unknown as typeof fetch)).toEqual({ ok: false, message: 'No route' })
    const down = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await fetchQuote(cfg, req(), down as unknown as typeof fetch)).toEqual({ ok: false, message: 'offline' })
  })
  it('follows a transfer, and holds an unknown hash as pending', async () => {
    const f = (status: number, s?: string) => vi.fn(async () => new Response(JSON.stringify({ status: s }), { status })) as unknown as typeof fetch
    expect(await fetchStatus(cfg, '0x1', 1, 56, f(200, 'DONE'))).toBe('done')
    expect(await fetchStatus(cfg, '0x1', 1, 56, f(200, 'FAILED'))).toBe('failed')
    expect(await fetchStatus(cfg, '0x1', 1, 56, f(200, 'PENDING'))).toBe('pending')
    expect(await fetchStatus(cfg, '0x1', 1, 56, f(404))).toBe('pending')
  })
  it('estimates one block on one chain, and a minute more across two until quoted', () => {
    expect(swapEstimate(eth, wznn, 12, null)).toBe(12)
    expect(swapEstimate(eth, bnb, 12, null)).toBe(72)
    const r = parseQuote(cfg, req({ to: bnb }), body())
    if (!r.ok) throw new Error('unreachable')
    expect(swapEstimate(eth, bnb, 12, r.quote)).toBe(48)
  })
  it('tells assets apart by chain and address, not by case', () => {
    expect(isNative(eth)).toBe(true)
    expect(isNative(wznn)).toBe(false)
    expect(sameAsset(wznn, { ...wznn, address: wznn.address.toLowerCase() })).toBe(true)
    expect(sameAsset(eth, bnb)).toBe(false)
    expect(sameAsset(eth, null)).toBe(false)
  })
})
