// go-zenon's embedded-contract ABI (`vm/abi`), the encoding direction, for
// the types the bridge and liquidity contracts take. Extended from the ptlc
// lab's encoder (zenon-ptlc/lab/web/src/znn/abi.ts).
//
//   - method id = the first 4 bytes of SHA3-256("Name(type,type,...)"). SHA3,
//     not Keccak: an EVM selector for the same signature is a different value.
//   - 32-byte words, head and tail: static arguments inline, `string` and
//     `bytes` as an offset in the head and [length, right-padded data] in the
//     tail.
//   - address and tokenStandard are LEFT-padded to 32, like integers.
//
// tests/unit/abi.test.ts checks the ids against the data prefixes of real
// mainnet bridge blocks.

import { bytesToBigInt, concat, formatAddress, fromBase64, hash, leftPad, parseAddress, parseZts, toHex } from './primitives.ts'

const WORD = 32

export type AbiType =
  | 'address'
  | 'hash'
  | 'tokenStandard'
  | 'bool'
  | 'uint32'
  | 'uint64'
  | 'int64'
  | 'uint256'
  | 'string'
  | 'bytes'
export type AbiValue = string | number | bigint | boolean | Uint8Array

const DYNAMIC: ReadonlySet<AbiType> = new Set(['string', 'bytes'])

function u256(v: bigint): Uint8Array {
  if (v < 0n) throw new Error(`negative value ${v} is not encodable here`)
  if (v >= 1n << 256n) throw new Error(`${v} does not fit 256 bits`)
  const out = new Uint8Array(WORD)
  let x = v
  for (let i = WORD - 1; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return out
}

function toBigInt(v: AbiValue): bigint {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error(`${v} is not an integer`)
    return BigInt(v)
  }
  if (typeof v === 'string') return BigInt(v)
  throw new Error('not a number')
}

const LIMITS: Partial<Record<AbiType, bigint>> = {
  uint32: 1n << 32n,
  uint64: 1n << 64n,
  int64: 1n << 63n,
}

function encodeStatic(type: AbiType, value: AbiValue): Uint8Array {
  switch (type) {
    case 'address':
      return leftPad(typeof value === 'string' ? parseAddress(value) : (value as Uint8Array), WORD)
    case 'tokenStandard':
      return leftPad(typeof value === 'string' ? parseZts(value) : (value as Uint8Array), WORD)
    case 'hash': {
      const raw = typeof value === 'string' ? hexToBytes(value) : (value as Uint8Array)
      if (raw.length !== WORD) throw new Error(`a hash is 32 bytes, got ${raw.length}`)
      return raw
    }
    case 'bool':
      return u256(value ? 1n : 0n)
    case 'uint32':
    case 'uint64':
    case 'int64':
    case 'uint256': {
      const v = toBigInt(value)
      const limit = LIMITS[type]
      if (limit !== undefined && v >= limit) throw new Error(`${v} does not fit ${type}`)
      return u256(v)
    }
    default:
      throw new Error(`${type} is not static`)
  }
}

function hexToBytes(s: string): Uint8Array {
  const clean = s.startsWith('0x') ? s.slice(2) : s
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) throw new Error(`not hex: ${s}`)
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function packDynamic(raw: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(raw.length / WORD) * WORD)
  padded.set(raw)
  return concat(u256(BigInt(raw.length)), padded)
}

export function methodId(name: string, types: readonly AbiType[]): Uint8Array {
  return hash(new TextEncoder().encode(`${name}(${types.join(',')})`)).subarray(0, 4)
}

/** The 4-byte method id followed by the packed arguments. */
export function encodeCall(name: string, types: readonly AbiType[], values: readonly AbiValue[]): Uint8Array {
  if (types.length !== values.length) throw new Error(`${name} takes ${types.length} arguments, got ${values.length}`)
  const head: Uint8Array[] = []
  const tail: Uint8Array[] = []
  let offset = types.length * WORD
  types.forEach((type, i) => {
    if (DYNAMIC.has(type)) {
      const v = values[i]
      const raw = typeof v === 'string' ? new TextEncoder().encode(v) : (v as Uint8Array)
      const packed = packDynamic(raw)
      head.push(u256(BigInt(offset)))
      tail.push(packed)
      offset += packed.length
    } else {
      head.push(encodeStatic(type, values[i]))
    }
  })
  return concat(methodId(name, types), ...head, ...tail)
}

export type Decoded = string | bigint | boolean

/**
 * Decodes the arguments after a method id. Lenient where the contract is
 * lenient: it is used to read blocks already accepted by the chain, not to
 * judge them. Returns null when the data is too short for `types`.
 */
export function decodeArguments(data: Uint8Array, types: readonly AbiType[]): Decoded[] | null {
  if (data.length < types.length * WORD) return null
  const out: Decoded[] = []
  for (let i = 0; i < types.length; i++) {
    const word = data.subarray(i * WORD, (i + 1) * WORD)
    const type = types[i]
    switch (type) {
      case 'address':
        out.push(formatAddress(word.subarray(12)))
        break
      case 'hash':
        out.push(toHex(word))
        break
      case 'bool':
        out.push(word[31] === 1)
        break
      case 'string':
      case 'bytes': {
        const at = Number(bytesToBigInt(word))
        if (at + WORD > data.length) return null
        const size = Number(bytesToBigInt(data.subarray(at, at + WORD)))
        if (at + WORD + size > data.length) return null
        const raw = data.subarray(at + WORD, at + WORD + size)
        out.push(type === 'string' ? new TextDecoder().decode(raw) : toHex(raw))
        break
      }
      case 'tokenStandard':
        out.push(toHex(word.subarray(22)))
        break
      default:
        out.push(bytesToBigInt(word))
    }
  }
  return out
}

/** Hex of the method id a base64 block payload starts with, or '' if it has none. */
export function selectorOf(dataBase64: string | null | undefined): string {
  if (!dataBase64) return ''
  try {
    const raw = fromBase64(dataBase64)
    return raw.length >= 4 ? toHex(raw.subarray(0, 4)) : ''
  } catch {
    return ''
  }
}
