// What a transfer costs and how long it takes, from the token pair as the
// Zenon bridge reports it (`getAllNetworks`).

export const FEE_DENOMINATOR = 10_000n

/** Wrap fee, as go-zenon computes it: amount × feePercentage / 10000, rounded down. */
export function wrapFee(amount: bigint, feePercentage: number): bigint {
  return (amount * BigInt(feePercentage)) / FEE_DENOMINATOR
}

export function wrapReceive(amount: bigint, feePercentage: number): bigint {
  return amount - wrapFee(amount, feePercentage)
}

/**
 * Unwrap: no bridge fee. With a referrer and the program active for the token,
 * the orchestrator pays the unwrapper an extra 1% (HyperCore orchestrator,
 * network/evm.go: amount / 100 added).
 */
export function unwrapReceive(amount: bigint, affiliateBonus: boolean): bigint {
  return affiliateBonus ? amount + amount / 100n : amount
}

export interface TimeEstimate {
  /** Seconds until the request can be redeemed, best case. */
  seconds: number
  steps: string[]
}

/**
 * Wrap: Zenon finality (confirmationsToFinality momentums), the signing
 * ceremony, then the EVM bridge's redeemDelay blocks between the two redeems.
 */
export function wrapEstimate(o: {
  confirmationsToFinality: number
  momentumSeconds: number
  evmRedeemDelayBlocks: number
  evmBlockSeconds: number
  signingSeconds?: number
}): TimeEstimate {
  const zenon = o.confirmationsToFinality * o.momentumSeconds
  const sign = o.signingSeconds ?? 120
  const evm = o.evmRedeemDelayBlocks * o.evmBlockSeconds
  return { seconds: zenon + sign + evm, steps: ['Zenon finality', 'Signing', 'EVM delay'] }
}

/** Unwrap: EVM confirmations, signing, then redeemDelay momentums on Zenon. */
export function unwrapEstimate(o: {
  evmConfirmations: number
  evmBlockSeconds: number
  redeemDelayMomentums: number
  momentumSeconds: number
  signingSeconds?: number
}): TimeEstimate {
  const evm = o.evmConfirmations * o.evmBlockSeconds
  const sign = o.signingSeconds ?? 120
  const zenon = o.redeemDelayMomentums * o.momentumSeconds
  return { seconds: evm + sign + zenon, steps: ['EVM finality', 'Signing', 'Zenon delay'] }
}

/** The fixed plasma a send needs without proof of work (go-zenon `AccountBlockBasePlasma`). */
export const BASE_PLASMA = 21_000
/** The original's "low plasma" hint threshold: enough for a few contract calls. */
export const LOW_PLASMA = 75_000
