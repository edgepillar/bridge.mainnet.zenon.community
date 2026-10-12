// The EVM wallet the user picked from the ones EIP-6963 found.

import { reactive, markRaw } from 'vue'
import {
  discoverWallets,
  requestAccounts,
  chainIdOf,
  switchChain,
  type DiscoveredWallet,
  type Eip1193Provider,
} from '../wallet/eip6963.ts'
import { evmChain } from '../config.ts'

const LAST = 'bridge.evmWallet'

export const evm = reactive({
  wallets: [] as DiscoveredWallet[],
  selected: null as DiscoveredWallet | null,
  account: null as `0x${string}` | null,
  chainId: null as number | null,
  busy: false,
  pickerOpen: false,
})

let detach: (() => void) | null = null

export function startEvmDiscovery() {
  discoverWallets((list) => {
    evm.wallets = list.map((w) => markRaw(w))
    // Reconnect silently to the wallet used last time, if it still authorises us.
    const last = safeGet(LAST)
    if (!evm.selected && last) {
      const w = list.find((x) => x.info.rdns === last)
      if (w) void reconnect(w)
    }
  })
}

async function reconnect(w: DiscoveredWallet) {
  try {
    const accounts = (await w.provider.request({ method: 'eth_accounts' })) as string[]
    if (accounts?.length) await bind(w, accounts)
  } catch {
    /* needs a prompt; wait for the user */
  }
}

async function bind(w: DiscoveredWallet, accounts: string[]) {
  detach?.()
  evm.selected = markRaw(w)
  evm.account = (accounts[0] as `0x${string}`) ?? null
  evm.chainId = await chainIdOf(w.provider)
  safeSet(LAST, w.info.rdns)
  const onAccounts = (a: string[]) => {
    if (!a?.length) return disconnectEvm()
    evm.account = a[0] as `0x${string}`
  }
  const onChain = (id: string) => (evm.chainId = Number(id))
  w.provider.on?.('accountsChanged', onAccounts as never)
  w.provider.on?.('chainChanged', onChain as never)
  detach = () => {
    w.provider.removeListener?.('accountsChanged', onAccounts as never)
    w.provider.removeListener?.('chainChanged', onChain as never)
  }
}

export async function connectEvm(w: DiscoveredWallet) {
  evm.busy = true
  try {
    await bind(w, await requestAccounts(w.provider))
  } finally {
    evm.busy = false
  }
}

export function disconnectEvm() {
  detach?.()
  detach = null
  evm.selected = null
  evm.account = null
  evm.chainId = null
  safeSet(LAST, '')
}

export async function ensureChain(chainId: number) {
  if (!evm.selected) throw new Error('Connect an EVM wallet first')
  if (evm.chainId === chainId) return
  const c = evmChain(chainId)
  await switchChain(evm.selected.provider, chainId, { name: c.name, rpc: c.rpc, nativeSymbol: c.nativeSymbol, explorer: c.explorer })
  evm.chainId = await chainIdOf(evm.selected.provider)
  if (evm.chainId !== chainId) throw new Error(`Switch your wallet to ${c.name}`)
}

/** The wallet as readClient wants it, or null. */
export function walletForReads(): { provider: Eip1193Provider; chainId: number } | null {
  return evm.selected && evm.chainId ? { provider: evm.selected.provider, chainId: evm.chainId } : null
}

function safeGet(k: string) {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function safeSet(k: string, v: string) {
  try {
    if (v) localStorage.setItem(k, v)
    else localStorage.removeItem(k)
  } catch {
    /* ignore */
  }
}
