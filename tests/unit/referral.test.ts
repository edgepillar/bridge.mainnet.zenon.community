import { describe, expect, it } from 'vitest'
import { mangle, unmangle, referrerFromCode, recipientString, applyReferral, linkFor, type ReferralStore } from '../../src/core/referral.ts'

const ADDR = 'z1qr9vtwsfr2n0nsxl2nfh6l5esqjh2wfj85cfq9'
const OTHER = 'z1qpqn7uqlqyqeuf3z5sudvk2tgg2ghwa9pyq5ny'

// The original deployment's functions (src/utils/mangling.tsx), kept as an
// oracle so a link made by either app reads the same in both.
function originalMangle(input: string, secret: string): string {
  let output = ''
  for (let i = 0; i < input.length; i++) output += String.fromCharCode(input.charCodeAt(i) ^ secret.charCodeAt(i % secret.length))
  return output
    .split('')
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
}

function memoryStore(initial: string | null = null): ReferralStore & { value: string | null } {
  return {
    value: initial,
    get() {
      return this.value
    },
    set(c) {
      this.value = c
    },
    clear() {
      this.value = null
    },
  }
}

describe('referral codes', () => {
  it('match the original mangling', () => {
    expect(mangle(ADDR)).toBe(originalMangle(ADDR, 'UjFpyVLBUHC'))
  })
  it('round trip', () => {
    expect(unmangle(mangle(ADDR))).toBe(ADDR)
    expect(referrerFromCode(mangle(ADDR))).toBe(ADDR)
  })
  it('reject codes that do not decode to an address', () => {
    expect(referrerFromCode('zz')).toBeNull()
    expect(referrerFromCode('abc')).toBeNull()
    expect(referrerFromCode(mangle('not-an-address'))).toBeNull()
    expect(referrerFromCode('')).toBeNull()
  })
  it('make links the original reads', () => {
    expect(linkFor(ADDR, 'https://bridge.mainnet.zenon.community/')).toBe(`https://bridge.mainnet.zenon.community/?referral=${originalMangle(ADDR, 'UjFpyVLBUHC')}`)
  })
})

describe('first referral wins', () => {
  it('stores the first valid code', () => {
    const s = memoryStore()
    expect(applyReferral(mangle(ADDR), s)).toBe(ADDR)
    expect(s.value).toBe(mangle(ADDR))
  })
  it('keeps the stored one when another arrives', () => {
    const s = memoryStore(mangle(ADDR))
    expect(applyReferral(mangle(OTHER), s)).toBe(ADDR)
    expect(s.value).toBe(mangle(ADDR))
  })
  it('replaces a stored code that is not valid', () => {
    const s = memoryStore('garbage')
    expect(applyReferral(mangle(OTHER), s)).toBe(OTHER)
  })
  it('ignores an invalid incoming code', () => {
    const s = memoryStore()
    expect(applyReferral('nope', s)).toBeNull()
    expect(s.value).toBeNull()
  })
})

describe('unwrap recipient string', () => {
  it('appends the decoded referrer address, never the code', () => {
    const to = recipientString(OTHER, ADDR)
    expect(to).toBe(`${OTHER}&${ADDR}`)
    expect(to).not.toContain(mangle(ADDR))
  })
  it('leaves it alone with no referrer or a self-referral', () => {
    expect(recipientString(OTHER, null)).toBe(OTHER)
    expect(recipientString(ADDR, ADDR)).toBe(ADDR)
  })
})
