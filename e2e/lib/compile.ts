// Compiles e2e/contracts with solc-js. Imports resolve from node_modules, so
// OpenZeppelin comes from the pinned npm package. The result is cached in
// e2e/.cache by source hash: a compile takes ~20 s and the sources rarely
// change.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Abi } from 'viem'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const contractsDir = path.join(here, '..', 'contracts')
const cacheDir = path.join(here, '..', '.cache')
const nodeModules = path.join(here, '..', '..', 'node_modules')

export interface Artifact {
  abi: Abi
  bytecode: `0x${string}`
}

export function compileContracts(): { Bridge: Artifact; TestToken: Artifact } {
  const sources: Record<string, { content: string }> = {}
  for (const f of ['Bridge.sol', 'TestToken.sol']) sources[f] = { content: fs.readFileSync(path.join(contractsDir, f), 'utf8') }
  const key = crypto.createHash('sha256').update(JSON.stringify(sources)).digest('hex').slice(0, 16)
  const cached = path.join(cacheDir, `contracts-${key}.json`)
  if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, 'utf8'))

  const solc = require('solc')
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  }
  const findImports = (p: string) => {
    try {
      return { contents: fs.readFileSync(path.join(nodeModules, p), 'utf8') }
    } catch {
      return { error: `not found: ${p}` }
    }
  }
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }))
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error')
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'))
  const pick = (file: string, name: string): Artifact => ({
    abi: out.contracts[file][name].abi,
    bytecode: `0x${out.contracts[file][name].evm.bytecode.object}`,
  })
  const result = { Bridge: pick('Bridge.sol', 'Bridge'), TestToken: pick('TestToken.sol', 'TestToken') }
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(cached, JSON.stringify(result))
  return result
}
