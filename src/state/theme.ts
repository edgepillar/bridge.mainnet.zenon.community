// Light, dark, or the OS's choice until the user picks one. The attribute is
// first set by a few lines in index.html, before paint.
import { ref } from 'vue'

export type Theme = 'dark' | 'light'
const KEY = 'bridge.theme'

function initial(): Theme {
  const set = document.documentElement.getAttribute('data-theme')
  if (set === 'light' || set === 'dark') return set
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export const theme = ref<Theme>(initial())

export function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', theme.value)
  try {
    localStorage.setItem(KEY, theme.value)
  } catch {
    /* blocked storage: holds for this tab */
  }
}
