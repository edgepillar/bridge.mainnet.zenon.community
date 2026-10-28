import { reactive } from 'vue'
import type { Tone } from '../core/status.ts'
import { userMessage } from '../core/errors.ts'

export interface Toast {
  id: number
  tone: Tone
  text: string
  link?: { href: string; label: string }
  ms: number
}

export const toasts = reactive<Toast[]>([])
let n = 0
let timer: ReturnType<typeof setTimeout> | undefined

export const TOAST_MS = 2500
export const TOAST_ERROR_MS = 4000

export function toast(text: string, tone: Tone = 'ok', link?: Toast['link'], ms = TOAST_MS): void {
  const id = ++n
  clearTimeout(timer)
  toasts.splice(0, toasts.length)
  // An explorer that does not cover the chain in use gives an empty href.
  toasts.push({ id, tone, text, link: link?.href ? link : undefined, ms })
  timer = setTimeout(() => dismiss(id), ms)
}

export function dismiss(id: number): void {
  const i = toasts.findIndex((t) => t.id === id)
  if (i >= 0) toasts.splice(i, 1)
}

export function toastError(err: unknown, prefix = ''): void {
  const m = userMessage(err)
  if (m.declined) return toast(m.text, 'dim')
  toast(`${prefix}${m.text}`, 'danger', undefined, TOAST_ERROR_MS)
}
