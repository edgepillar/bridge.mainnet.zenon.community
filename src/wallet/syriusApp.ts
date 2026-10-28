
import type { BlockJson } from '../znn/block.ts'
import { isUserAddress } from '../znn/primitives.ts'

export type AppMethod = 'znn_connect' | 'znn_chainId' | 'znn_signAndSendBlock'

export interface PendingRequest {
  id: string
  method: AppMethod
  createdAt: number
  operationId?: string
  template?: BlockJson
  account?: string
  record?: Record<string, unknown>
}

export interface AppSession {
  address: string
  chainId: number | null
}

export interface AppAnswer {
  id: string
  result?: unknown
  error?: { code: number; message: string }
}

const REQUESTS_KEY = 'bridge.syrius.requests'
export const SESSION_KEY = 'bridge.syrius.app'
export const REQUEST_TTL_MS = 35 * 60_000
const MAX_PENDING = 8

export class AppHandoffError extends Error {
  constructor() {
    super('Approve in Syrius')
    this.name = 'AppHandoffError'
  }
}

export function isPhone(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> = navigator): boolean {
  const ua = nav.userAgent || ''
  const mobile = (nav as { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile
  return mobile === true || /Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1)
}

export const base64url = {
  encode(text: string): string {
    const bytes = new TextEncoder().encode(text)
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  },
  decode(text: string): string {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')
    return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)))
  },
}

export function callbackUrl(route: string, loc: Pick<Location, 'origin' | 'pathname'> = location): string {
  return `${loc.origin}${loc.pathname}?syrius=1#/${route.replace(/^[#/]+/, '')}`
}

export function requestLink(method: AppMethod, params: unknown, id: string, callback: string): string {
  const q = new URLSearchParams({ method, params: base64url.encode(JSON.stringify(params ?? {})), id, callback })
  return `syrius://request?${q.toString()}`
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const text = localStorage.getItem(key)
    return text ? (JSON.parse(text) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
  }
}

function validPending(p: unknown, now: number): p is PendingRequest {
  const r = p as PendingRequest
  return !!r && typeof r.id === 'string' && r.id.length <= 128 && ['znn_connect', 'znn_chainId', 'znn_signAndSendBlock'].includes(r.method) &&
    Number.isFinite(r.createdAt) && now - r.createdAt < REQUEST_TTL_MS && now - r.createdAt > -60_000
}

export function pendingRequests(now = Date.now()): PendingRequest[] {
  const list = readJson<unknown>(REQUESTS_KEY, [])
  return Array.isArray(list) ? list.filter((p) => validPending(p, now)) : []
}

function savePending(list: PendingRequest[]) {
  writeJson(REQUESTS_KEY, list.length ? list.slice(-MAX_PENDING) : null)
}

export function takePending(id: string, now = Date.now()): PendingRequest | null {
  const list = pendingRequests(now)
  const found = list.find((p) => p.id === id) ?? null
  savePending(list.filter((p) => p.id !== id))
  return found
}

export function readSession(): AppSession | null {
  const s = readJson<AppSession | null>(SESSION_KEY, null)
  if (!s || typeof s.address !== 'string' || !isUserAddress(s.address)) return null
  const chainId = s.chainId === null ? null : Number(s.chainId)
  return { address: s.address, chainId: chainId !== null && Number.isSafeInteger(chainId) && chainId > 0 ? chainId : null }
}

export function writeSession(s: AppSession | null) {
  writeJson(SESSION_KEY, s)
}

export function openRequest(method: AppMethod, params: unknown, extra: Omit<PendingRequest, 'id' | 'method' | 'createdAt'> = {}, route = currentRoute(),
  open: (url: string) => void = (url) => { window.location.href = url }): PendingRequest {
  const request: PendingRequest = { id: crypto.randomUUID(), method, createdAt: Date.now(), ...extra }
  savePending([...pendingRequests(), request])
  open(requestLink(method, params, request.id, callbackUrl(route)))
  return request
}

function currentRoute(): string {
  return location.hash.replace(/^#\/?/, '').split('?')[0]
}

export function takeAnswerFromUrl(loc: Pick<Location, 'href'> = location, replace: (url: string) => void = (url) => history.replaceState(null, '', url)): AppAnswer | null {
  let url: URL
  try { url = new URL(loc.href) } catch { return null }
  if (url.searchParams.get('syrius') !== '1') return null
  const id = url.searchParams.get('id')
  const result = url.searchParams.get('result')
  const error = url.searchParams.get('error')
  for (const k of ['syrius', 'id', 'result', 'error']) url.searchParams.delete(k)
  replace(url.toString())
  return parseAnswer(id, result, error)
}

export function parseAnswer(id: string | null, result: string | null, error: string | null): AppAnswer | null {
  if (!id || id.length > 128) return null
  try {
    if (error !== null) {
      const e = JSON.parse(base64url.decode(error)) as { code?: unknown; message?: unknown }
      return { id, error: { code: typeof e?.code === 'number' ? e.code : -32603, message: typeof e?.message === 'string' ? e.message.slice(0, 300) : '' } }
    }
    if (result !== null) return { id, result: JSON.parse(base64url.decode(result)) }
  } catch {
    return { id, error: { code: -32603, message: 'Unreadable answer from Syrius' } }
  }
  return null
}
