// The Zenon call data the app builds, checked against blocks the mainnet
// bridge accepted (fixtures read 2026-10-12 from node.zenonhub.io).
import { describe, expect, it } from 'vitest'
import { methodId, encodeCall, decodeArguments, selectorOf } from '../../src/znn/abi.ts'
import { toHex, fromBase64 } from '../../src/znn/primitives.ts'
import { wrapTokenBlock, redeemBlock, liquidityStakeBlock, cancelLiquidityStakeBlock, collectRewardBlock } from '../../src/znn/api.ts'
import { SELECTOR } from '../../src/core/orchestrators.ts'
import { BRIDGE, LIQUIDITY } from '../../src/config.ts'

// A WrapToken send: 0.000069 ZNNETHLP to 0xbe09…1c87 on Ethereum.
const WRAP_TOKEN_DATA =
  'YdIkvAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqMHhiZTA5MGMzNzg4YmMwMzgzMTY1Y2Y5MjI4M2RmOTE5MzA4OTAxYzg3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='
// A Redeem send.
const REDEEM_DATA = '1OBseVsqHVvFY/H3YYfiXVl2DVRnVJ09407G1FP0jB1LkR60AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAO5rKH4='

describe('method ids', () => {
  it('match the selectors seen on the mainnet bridge chain', () => {
    expect(toHex(methodId('WrapToken', ['uint32', 'uint32', 'string']))).toBe(SELECTOR.wrapToken)
    expect(toHex(methodId('UpdateWrapRequest', ['hash', 'string']))).toBe(SELECTOR.updateWrapRequest)
    expect(toHex(methodId('UnwrapToken', ['uint32', 'uint32', 'hash', 'uint32', 'address', 'string', 'uint256', 'string']))).toBe(
      SELECTOR.unwrapToken,
    )
    expect(toHex(methodId('Redeem', ['hash', 'uint32']))).toBe(SELECTOR.redeem)
  })

  it('are SHA3, not Keccak: the original prefixes 1LsRw and tgaUAQ', () => {
    expect(btoaHex(SELECTOR.updateWrapRequest).startsWith('1LsRw')).toBe(true)
    expect(btoaHex(SELECTOR.unwrapToken).startsWith('tgaUAQ')).toBe(true)
  })
})

describe('WrapToken', () => {
  it('encodes byte for byte as the mainnet block', () => {
    const spec = wrapTokenBlock({
      networkClass: 2,
      chainId: 1,
      toAddress: '0xbe090c3788bc0383165cf92283df919308901c87',
      tokenStandard: 'zts17d6yr02kh0r9qr566p7tg6',
      amount: 69648350815046n,
    })
    expect(spec.toAddress).toBe(BRIDGE)
    expect(Buffer.from(spec.data!).toString('base64')).toBe(WRAP_TOKEN_DATA)
  })

  it('lowercases a checksummed recipient, as the original did', () => {
    const a = wrapTokenBlock({ networkClass: 2, chainId: 1, toAddress: '0xBE090c3788bc0383165cf92283df919308901c87', tokenStandard: 'zts1znnxxxxxxxxxxxxx9z4ulx', amount: 1n })
    expect(new TextDecoder().decode(a.data!)).toContain('0xbe090c3788bc0383165cf92283df919308901c87')
  })

  it('decodes back', () => {
    const args = decodeArguments(fromBase64(WRAP_TOKEN_DATA).subarray(4), ['uint32', 'uint32', 'string'])
    expect(args).toEqual([2n, 1n, '0xbe090c3788bc0383165cf92283df919308901c87'])
  })
})

describe('Redeem', () => {
  it('encodes byte for byte as the mainnet block', () => {
    const raw = fromBase64(REDEEM_DATA)
    const [hash, logIndex] = decodeArguments(raw.subarray(4), ['hash', 'uint32'])!
    const spec = redeemBlock(hash as string, Number(logIndex))
    expect(Buffer.from(spec.data!).toString('base64')).toBe(REDEEM_DATA)
    expect(spec.toAddress).toBe(BRIDGE)
    // An EVM tx hash with 0x is accepted too.
    expect(Buffer.from(redeemBlock('0x' + (hash as string), Number(logIndex)).data!).toString('base64')).toBe(REDEEM_DATA)
  })
})

describe('liquidity calls', () => {
  it('stakes for whole 30-day months', () => {
    const s = liquidityStakeBlock(3, 'zts17d6yr02kh0r9qr566p7tg6', 5n)
    expect(s.toAddress).toBe(LIQUIDITY)
    expect(s.amount).toBe(5n)
    const [secs] = decodeArguments(s.data!.subarray(4), ['int64'])!
    expect(secs).toBe(3n * 2592000n)
  })

  it('cancel and collect carry the right ids', () => {
    expect(toHex(cancelLiquidityStakeBlock('ab'.repeat(32)).data!.subarray(0, 4))).toBe(toHex(methodId('CancelLiquidityStake', ['hash'])))
    expect(collectRewardBlock().data!.length).toBe(4)
  })
})

describe('encoder limits', () => {
  it('refuses a value that does not fit its type', () => {
    expect(() => encodeCall('X', ['uint32'], [2n ** 32n])).toThrow()
    expect(() => encodeCall('X', ['int64'], [2n ** 63n])).toThrow()
  })
  it('selectorOf reads the first four bytes', () => {
    expect(selectorOf(WRAP_TOKEN_DATA)).toBe('61d224bc')
    expect(selectorOf('')).toBe('')
    expect(selectorOf('!!')).toBe('')
  })
})

function btoaHex(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64')
}
