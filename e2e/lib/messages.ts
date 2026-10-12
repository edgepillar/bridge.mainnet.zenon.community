// The two messages the orchestrators sign, byte for byte as go-zenon builds
// and checks them (vm/embedded/implementation/bridge.go,
// GetWrapTokenRequestMessage and GetUnwrapTokenRequestMessage), and as the
// HyperCore EVM bridge rebuilds the wrap one in `redeem`:
//
//   wrap:   keccak(abi.encode(uint256 class, uint256 chainId, address bridge,
//                             uint256 id, address to, address token,
//                             uint256 amount - fee))
//   unwrap: keccak(abi.encode(uint256 class, uint256 chainId, uint256 txHash,
//                             uint256 logIndex, uint256 toAddress(20 bytes),
//                             address token, uint256 amount))
//
// then the Ethereum signed-message prefix, then keccak again. The signature
// is 65 bytes, r||s||v with v in {0, 1}: what Zenon's secp256k1.RecoverPubkey
// takes. The EVM side wants 27 or 28 (src/core/status.ts evmSignature).

import { encodeAbiParameters, keccak256, hashMessage, type Hex } from 'viem'
import { secp256k1 } from '@noble/curves/secp256k1'
import { parseAddress, toHex, fromHex } from '../../src/znn/primitives.ts'

export function wrapMessage(o: {
  networkClass: number
  chainId: number
  bridge: `0x${string}`
  id: string
  to: `0x${string}`
  token: `0x${string}`
  amountMinusFee: bigint
}): Hex {
  const packed = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [BigInt(o.networkClass), BigInt(o.chainId), o.bridge, BigInt('0x' + o.id.replace(/^0x/, '')), o.to, o.token, o.amountMinusFee],
  )
  return hashMessage({ raw: keccak256(packed) })
}

export function unwrapMessage(o: {
  networkClass: number
  chainId: number
  txHash: string
  logIndex: number
  toAddress: string
  token: `0x${string}`
  amount: bigint
}): Hex {
  const to = BigInt('0x' + toHex(parseAddress(o.toAddress)))
  const packed = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }],
    [BigInt(o.networkClass), BigInt(o.chainId), BigInt('0x' + o.txHash.replace(/^0x/, '')), BigInt(o.logIndex), to, o.token, o.amount],
  )
  return hashMessage({ raw: keccak256(packed) })
}

/** r||s||v, v in {0,1}, base64: the form Zenon stores and checks. */
export function signTss(digest: Hex, privateKey: Uint8Array): string {
  const sig = secp256k1.sign(fromHex(digest), privateKey)
  const out = new Uint8Array(65)
  out.set(sig.toCompactRawBytes(), 0)
  out[64] = sig.recovery
  return Buffer.from(out).toString('base64')
}

/** The 65-byte uncompressed public key, base64: what `SetTss`/genesis setup takes. */
export function tssPublicKey(privateKey: Uint8Array, compressed = false): string {
  return Buffer.from(secp256k1.getPublicKey(privateKey, compressed)).toString('base64')
}

/** The EVM address of an uncompressed secp256k1 public key (base64). */
export function evmAddressOfPublicKey(base64: string): `0x${string}` {
  const raw = Uint8Array.from(Buffer.from(base64, 'base64'))
  const body = raw.length === 65 ? raw.subarray(1) : secp256k1.ProjectivePoint.fromHex(raw).toRawBytes(false).subarray(1)
  return `0x${keccak256(body).slice(-40)}`
}
