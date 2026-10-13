import { reactive } from 'vue'
import type { Tone } from '../core/status.ts'
import { userMessage } from '../core/errors.ts'

export interface Toast {
  id: number
  tone: Tone
  text: string
  link?: { href: string; label: string }
}

export const toasts = reactive<Toast[]>([])
let n = 0

export function toast(text: string, tone: Tone = 'ok', link?: Toast['link'], ms = 5000): void {
  const id = ++n
  // An explorer that does not cover the chain in use gives an empty href.
  toasts.push({ id, tone, text, link: link?.href ? link : undefined })
  setTimeout(() => dismiss(id), ms)
}

export function dismiss(id: number): void {
  const i = toasts.findIndex((t) => t.id === id)
  if (i >= 0) toasts.splice(i, 1)
}

export function toastError(err: unknown, prefix = ''): void {
  const m = userMessage(err)
  if (m.declined) return toast(m.text, 'dim')
  toast(`${prefix}${m.text}`, 'danger', undefined, 8000)
}
