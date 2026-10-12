// Signs and publishes a block with a key the test holds: the e2e harness's
// stand-in for Syrius and for the orchestrator's Zenon side. From
// zenon-ptlc/lab/web/src/znn/block.ts.

import type { Account } from './wallet.ts'
import { minePoWNonce, powDataHash, type MiningOptions } from './pow.ts'
import { ZERO_NONCE, blockTemplate, computeBlockHash, type BlockJson, type BlockSpec } from '../../src/znn/block.ts'
import { ZERO_HASH_HEX, toBase64, toHex } from '../../src/znn/primitives.ts'
import type { ZenonClient } from '../../src/znn/client.ts'


/**
 * Completes, signs and publishes one block from `account`, and answers its
 * hash. A published `ptlc.Create` hash is also the entry's id, so the id is
 * known the moment the block is built, two momentums before the entry exists.
 */
export async function publishBlock(
  client: ZenonClient,
  account: Account,
  chainIdentifier: number,
  spec: BlockSpec,
  options: MiningOptions = {},
): Promise<BlockJson> {
  const [frontier, momentum] = await Promise.all([
    client.frontierAccountBlock(account.address),
    client.frontierMomentum(),
  ])

  const block = blockTemplate(spec, chainIdentifier)
  block.previousHash = frontier ? frontier.hash : ZERO_HASH_HEX
  block.height = frontier ? frontier.height + 1 : 1
  block.momentumAcknowledged = { hash: momentum.hash, height: momentum.height }
  block.address = account.address
  block.nonce = ZERO_NONCE

  const pow = await client.requiredPow(account.address, block.blockType, block.toAddress, block.data)

  if (pow.requiredDifficulty > 0) {
    block.fusedPlasma = pow.availablePlasma
    block.difficulty = pow.requiredDifficulty
    block.nonce = toHex(
      await minePoWNonce(pow.requiredDifficulty, powDataHash(block.address, block.previousHash), options),
    )
  } else {
    block.fusedPlasma = pow.basePlasma
  }
  block.basePlasma = pow.basePlasma
  block.usedPlasma = pow.basePlasma

  const digest = computeBlockHash(block)
  block.hash = toHex(digest)
  block.publicKey = toBase64(account.publicKey)
  block.signature = toBase64(account.sign(digest))

  await client.publish(block)
  return block
}
