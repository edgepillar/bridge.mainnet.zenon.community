// Hash routes: GitHub Pages serves one file and has no fallback for /stats.
// A query string before the hash (?referral=…) is left alone.
import { ref } from 'vue'

export type Route = 'bridge' | 'activity' | 'liquidity' | 'stats' | 'affiliate'
export const ROUTES: Array<{ id: Route; label: string; nav: boolean }> = [
  { id: 'bridge', label: 'Bridge', nav: true },
  { id: 'activity', label: 'Activity', nav: true },
  { id: 'liquidity', label: 'Liquidity', nav: true },
  { id: 'stats', label: 'Status', nav: true },
  { id: 'affiliate', label: 'Referral', nav: false },
]
export const NAV = ROUTES.filter((r) => r.nav)

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
