// Which of the two things the Bridge view is doing, and whether the swap
// routers can be reached. Shared because the header's banners depend on it:
// the bridge being down is no news to someone swapping, and the routers being
// down is no news to someone bridging.
import { computed, ref } from 'vue'
import { config } from '../config.ts'
import { checkRouters, type RouterHealth, type SwapAsset } from '../core/swap.ts'

export type Mode = 'bridge' | 'swap'
export const mode = ref<Mode>('bridge')

export const swapHealth = ref<RouterHealth | null>(null)
export const swapMessage = computed(() => {
  const h = swapHealth.value
  if (!h || (h.sameChain && h.crossChain)) return ''
  if (!h.sameChain && !h.crossChain) return 'No routes found. Try again later.'
  return h.crossChain ? 'Swaps on one chain have no route right now.' : 'Swaps between chains have no route right now.'
})

let checkedAt = 0
/** Asked on entering swap mode, at most once a minute. */
export async function checkSwap(sample: { from: SwapAsset; to: SwapAsset } | null) {
  if (!config.swap || Date.now() - checkedAt < 60_000) return
  checkedAt = Date.now()
  swapHealth.value = await checkRouters(config.swap, sample)
}
