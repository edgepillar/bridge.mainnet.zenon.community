// Hash routes: GitHub Pages serves one file and has no fallback for /stats.
// A query string before the hash (?referral=…) is left alone.
import { ref } from 'vue'

export type Route = 'bridge' | 'activity' | 'liquidity' | 'stats' | 'affiliate'
export const ROUTES: Array<{ id: Route; label: string }> = [
  { id: 'bridge', label: 'Bridge' },
  { id: 'activity', label: 'Activity' },
  { id: 'liquidity', label: 'Liquidity' },
  { id: 'stats', label: 'Stats' },
  { id: 'affiliate', label: 'Affiliate' },
]

function parse(): Route {
  const h = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0]
  return (ROUTES.find((r) => r.id === h)?.id ?? 'bridge') as Route
}

export const route = ref<Route>(parse())
window.addEventListener('hashchange', () => {
  route.value = parse()
  window.scrollTo({ top: 0 })
})

export function go(r: Route) {
  location.hash = r === 'bridge' ? '#/' : `#/${r}`
}

/** Set by another view to open Bridge on a given route (Liquidity's "Bridge LP"). */
export const bridgePrefill = ref<{ dir: 'wrap' | 'unwrap'; chainId: number; zts: string } | null>(null)
