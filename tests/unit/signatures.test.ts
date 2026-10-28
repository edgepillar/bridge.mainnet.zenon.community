// The wrap message and signature handling, checked against a request the
// mainnet orchestrators signed: the recovered signer must be the bridge's TSS
// key. This proves the message layout (shared with the e2e orchestrator) and
// the v adjustment the EVM redeem needs.
import { describe, expect, it } from 'vitest'
import { recoverAddress } from 'viem'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { wrapMessage, unwrapMessage, signTss, evmAddressOfPublicKey, tssPublicKey } from '../../e2e/lib/messages.ts'
import { evmSignature } from '../../src/core/status.ts'

// embedded.bridge.getAllWrapTokenRequests, 2026-10-12.
const SIGNED = {
  id: 'c879574efd8df5711a38bbf1c6dff22e711b6232e83657eb2ec270541baa3386',
  toAddress: '0xcfb256d3d35067bc0f5d32526d16184a973e4d1b' as const,
  tokenAddress: '0xb2e96a63479c2edd2fd62b382c89d5ca79f572d3' as const,
  amount: 299953212506n,
  fee: 8998596375n,
  signature: '6z/FssjosPiyu+ijgkPQrNMFNdGslSrGegZT1sHpKYVKCYLbAh/4nh7/DbPbMjEOt8+QCYIny1UfdkfDJ/xwOQA=',
}
const TSS_PUBKEY = 'BB+UOuLxcWVIoON3ww7f5yRwjUsUdjy9xTrM6TeqVyGnBtCLRba7zruoOzGhqqnQGaGajwAvQO3Czm6tcZlNW84='
const ETH_BRIDGE = '0xa98706106f7710d743186031be2245f33acea106' as const

describe('wrap signature from mainnet', () => {
  it('recovers to the TSS key the Zenon bridge holds', async () => {
    const digest = wrapMessage({
      networkClass: 2,
      chainId: 1,
      bridge: ETH_BRIDGE,
      id: SIGNED.id,
      to: SIGNED.toAddress,
      token: SIGNED.tokenAddress,
      amountMinusFee: SIGNED.amount - SIGNED.fee,
    })
    const signer = await recoverAddress({ hash: digest, signature: evmSignature(SIGNED.signature) })
    expect(signer.toLowerCase()).toBe(evmAddressOfPublicKey(TSS_PUBKEY))
  })

  it('evmSignature adds 27 to v and leaves an already-adjusted v alone', () => {
    const raw = Buffer.from(SIGNED.signature, 'base64')
    expect(raw[64]).toBe(0)
    const once = evmSignature(SIGNED.signature)
    expect(once.slice(-2)).toBe('1b')
    const adjusted = Buffer.from(once.slice(2), 'hex').toString('base64')
    expect(evmSignature(adjusted)).toBe(once)
  })

  it('refuses a signature of the wrong length', () => {
    expect(() => evmSignature(Buffer.alloc(64).toString('base64'))).toThrow()
  })
})

describe('test orchestrator signing', () => {
  const key = secp256k1.utils.randomSecretKey()

  it('signs a wrap so that the EVM recovers the TSS address', async () => {
    const digest = wrapMessage({ networkClass: 2, chainId: 31337, bridge: ETH_BRIDGE, id: 'ab'.repeat(32), to: SIGNED.toAddress, token: SIGNED.tokenAddress, amountMinusFee: 5n })
    const sig = signTss(digest, key)
    expect(Buffer.from(sig, 'base64')[64]).toBeLessThan(2)
    const signer = await recoverAddress({ hash: digest, signature: evmSignature(sig) })
    expect(signer.toLowerCase()).toBe(evmAddressOfPublicKey(tssPublicKey(key)))
  })

  it('builds the unwrap message with the z1 address as a 20-byte integer', () => {
    const a = unwrapMessage({ networkClass: 2, chainId: 1, txHash: '0x' + '11'.repeat(32), logIndex: 3, toAddress: 'z1qr9vtwsfr2n0nsxl2nfh6l5esqjh2wfj85cfq9', token: SIGNED.tokenAddress, amount: 1n })
    const b = unwrapMessage({ networkClass: 2, chainId: 1, txHash: '11'.repeat(32), logIndex: 3, toAddress: 'z1qr9vtwsfr2n0nsxl2nfh6l5esqjh2wfj85cfq9', token: SIGNED.tokenAddress, amount: 1n })
    expect(a).toBe(b)
    expect(a).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
