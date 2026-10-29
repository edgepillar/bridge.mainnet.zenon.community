// The Syrius extension's first protocol (v0.1.x), which the original bridge
// spoke (docs/FUNCTIONALITY.md, Zenon wallet). Everything goes over
// window.postMessage:
//
//   znn.requestWalletAccess        -> znn.grantedWalletRead {address, chainId, nodeUrl}
//                                     | znn.deniedWalletRead
//   znn.sendAccountBlockToSend     -> znn.accountBlockSent {signedTransaction}
//                                     | znn.deniedSendAccountBlock
//

import { WalletError } from './syrius.ts'

interface Granted {
  address: string
  chainId: number
  nodeUrl: string
}

type ZenonFlag = { isSyriusExtension?: boolean; sendAccountBlock?: unknown }

export function legacyPresent(): boolean {
  if (typeof window === 'undefined') return false
  const z = (window as unknown as { zenon?: ZenonFlag }).zenon ?? null
  if (typeof z?.sendAccountBlock === 'function') return false
  return Boolean(z?.isSyriusExtension) || legacyMark()
}

function legacyMark(): boolean {
  if (typeof document === 'undefined') return false
  for (const s of document.querySelectorAll('script:not([src])')) {
    if (/window\.zenon\.isSyriusExtension\s*=\s*true/.test(s.textContent ?? '')) return true
  }
  return false
}

function exchange<T>(send: { method: string; params?: unknown }, ok: string, denied: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new WalletError(4900, 'Syrius did not answer'))
    }, timeoutMs)
    function onMessage(ev: MessageEvent) {
      if (ev.source !== window || !ev.data || typeof ev.data !== 'object') return
      const { method, data } = ev.data as { method?: string; data?: unknown }
      if (method === ok) {
        clearTimeout(timer)
        window.removeEventListener('message', onMessage)
        resolve(data as T)
      } else if (method === denied) {
        clearTimeout(timer)
        window.removeEventListener('message', onMessage)
        reject(new WalletError(4001, 'declined in Syrius'))
      }
    }
    window.addEventListener('message', onMessage)
    window.postMessage(send, window.location.origin)
  })
}

export async function legacyConnect(): Promise<Granted> {
  const g = await exchange<Granted>({ method: 'znn.requestWalletAccess', params: {} }, 'znn.grantedWalletRead', 'znn.deniedWalletRead', 300_000)
  return { address: g.address, chainId: Number(g.chainId), nodeUrl: g.nodeUrl }
}

export async function legacySend(accountBlock: unknown): Promise<unknown> {
  const r = await exchange<{ signedTransaction?: unknown }>(
    { method: 'znn.sendAccountBlockToSend', params: accountBlock },
    'znn.accountBlockSent',
    'znn.deniedSendAccountBlock',
    600_000,
  )
  const signed = r?.signedTransaction ?? r
  return typeof signed === 'string' ? JSON.parse(signed) : signed
}
