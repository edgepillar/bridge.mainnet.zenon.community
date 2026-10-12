// A one-key stand-in for the orchestrator network, doing its two jobs:
//
//   wrap:    for every wrap request past finality with no signature, sign the
//            wrap message and publish UpdateWrapRequest(id, signature).
//   unwrap:  for every Unwrapped log on the EVM bridge past its confirmations,
//            sign the unwrap message and publish UnwrapToken(...). With a
//            "&z1referrer" suffix, the unwrapper gets 1% more and the referrer
//            a second request of 2% at logIndex + 4e9, as the real one does
//            (HyperCore orchestrator, network/evm.go).
//
// The real network signs with a threshold key over a libp2p ceremony; the
// messages, the encodings and the contract calls are the same, which is what
// the front end depends on. e2e/lib/messages.ts is checked against a mainnet
// signature in tests/unit/signatures.test.ts.

import { parseAbiItem } from 'viem'
import { EVM_CHAIN_ID, NETWORK_CLASS, TSS_KEY, evmPublic, send, sleep, zapi } from './lib/lab.ts'
import { wrapMessage, unwrapMessage, signTss } from './lib/messages.ts'
import { encodeCall } from '../src/znn/abi.ts'
import { BRIDGE } from '../src/config.ts'
import { isAddress } from '../src/znn/primitives.ts'
import { AFFILIATE_LOG_INDEX } from '../src/core/status.ts'
import { SEPARATOR } from '../src/core/referral.ts'

const UNWRAPPED = parseAbiItem('event Unwrapped(address indexed from, address indexed token, string to, uint256 amount)')

export interface OrchestratorOptions {
  bridge: `0x${string}`
  evmConfirmations: number
  /** Pay the affiliate bonus, as mainnet metadata turns on for wZNN and wQSR. */
  affiliate: boolean
  log?: (m: string) => void
}

export class TestOrchestrator {
  private running = false
  private fromBlock = 0n
  private done = new Set<string>()
  readonly o: OrchestratorOptions
  signedWraps = 0
  registeredUnwraps = 0

  constructor(o: OrchestratorOptions) {
    this.o = o
  }

  private log(m: string) {
    this.o.log?.(`[orchestrator] ${m}`)
  }

  /** One pass over both directions. */
  async tick(): Promise<void> {
    await this.signWraps()
    await this.registerUnwraps()
  }

  start(everyMs = 3000): void {
    this.running = true
    void (async () => {
      while (this.running) {
        try {
          await this.tick()
        } catch (err) {
          this.log(`tick failed: ${(err as Error).message}`)
        }
        await sleep(everyMs)
      }
    })()
  }

  stop(): void {
    this.running = false
  }

  private async signWraps(): Promise<void> {
    const page = await zapi.unsignedWraps(0, 50)
    for (const w of page.list) {
      if (w.confirmationsToFinality > 0 || w.chainId !== EVM_CHAIN_ID || this.done.has(w.id)) continue
      const digest = wrapMessage({
        networkClass: w.networkClass,
        chainId: w.chainId,
        bridge: this.o.bridge,
        id: w.id,
        to: w.toAddress as `0x${string}`,
        token: w.tokenAddress as `0x${string}`,
        amountMinusFee: w.amount - w.fee,
      })
      this.done.add(w.id)
      await send({ toAddress: BRIDGE, data: encodeCall('UpdateWrapRequest', ['hash', 'string'], [w.id, signTss(digest, TSS_KEY)]) })
      this.signedWraps++
      this.log(`signed wrap ${w.id.slice(0, 8)}`)
    }
  }

  private async registerUnwraps(): Promise<void> {
    const head = await evmPublic.getBlockNumber()
    const safe = head - BigInt(this.o.evmConfirmations)
    if (safe < this.fromBlock) return
    const logs = await evmPublic.getLogs({ address: this.o.bridge, event: UNWRAPPED, fromBlock: this.fromBlock, toBlock: safe })
    for (const l of logs) {
      const key = `${l.transactionHash}:${l.logIndex}`
      if (this.done.has(key)) continue
      this.done.add(key)
      const [to, referrer] = (l.args.to ?? '').split(SEPARATOR)
      if (!isAddress(to)) {
        this.log(`skipped unwrap with a bad recipient: ${l.args.to}`)
        continue
      }
      let amount = l.args.amount!
      const entries: Array<{ to: string; amount: bigint; logIndex: number }> = []
      if (this.o.affiliate && referrer && isAddress(referrer)) {
        entries.push({ to: referrer, amount: (amount * 2n) / 100n, logIndex: l.logIndex + AFFILIATE_LOG_INDEX })
        amount += amount / 100n
      }
      entries.unshift({ to, amount, logIndex: l.logIndex })
      for (const e of entries) {
        if (await zapi.unwrapByHashAndLog(l.transactionHash, e.logIndex).catch(() => null)) continue
        const digest = unwrapMessage({
          networkClass: NETWORK_CLASS,
          chainId: EVM_CHAIN_ID,
          txHash: l.transactionHash,
          logIndex: e.logIndex,
          toAddress: e.to,
          token: l.args.token!,
          amount: e.amount,
        })
        await send({
          toAddress: BRIDGE,
          data: encodeCall(
            'UnwrapToken',
            ['uint32', 'uint32', 'hash', 'uint32', 'address', 'string', 'uint256', 'string'],
            [NETWORK_CLASS, EVM_CHAIN_ID, l.transactionHash, e.logIndex, e.to, l.args.token!.toLowerCase(), e.amount, signTss(digest, TSS_KEY)],
          ),
        })
        this.registeredUnwraps++
        this.log(`registered unwrap ${l.transactionHash.slice(0, 10)} log ${e.logIndex} to ${e.to.slice(0, 10)}`)
      }
    }
    this.fromBlock = safe + 1n
  }
}
