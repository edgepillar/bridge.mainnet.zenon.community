<script setup lang="ts">
// Token and network marks from the original deployment; a lettered disc for
// anything else.
//
// `chain` adds the network's mark as a badge on the token's corner, so an
// asset always says which chain it is on: wZNN on Ethereum and wZNN on BNB
// Chain are different funds, and so are ZNN and wZNN.
import { computed } from 'vue'
import znn from '../assets/znn.svg'
import qsr from '../assets/qsr.svg'
import wznn from '../assets/wznn.svg'
import wqsr from '../assets/wqsr.svg'
import eth from '../assets/eth.svg'
import bnb from '../assets/bnb.svg'
import zenon from '../assets/zenon.svg'

const props = withDefaults(defineProps<{ symbol?: string; network?: string; chain?: string; size?: number }>(), { size: 24 })
const MAP: Record<string, string> = { ZNN: znn, QSR: qsr, WZNN: wznn, WQSR: wqsr, ETH: eth, WETH: eth, BNB: bnb }

function networkMark(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('zenon')) return zenon
  if (n.includes('bnb') || n.includes('bsc') || n.includes('binance')) return bnb
  if (n.includes('eth') || n.includes('anvil')) return eth
  return ''
}

const src = computed(() => {
  if (props.network !== undefined) return networkMark(props.network)
  // Only marks we have; anything else (WBTC, an LP token) gets a lettered disc
  // rather than a mark that reads as ZNN.
  return MAP[(props.symbol ?? '').toUpperCase()] ?? ''
})
const letter = computed(() => (props.symbol || props.network || '?').replace(/^w/i, '').slice(0, 1).toUpperCase())
const badge = computed(() => (props.chain ? networkMark(props.chain) : ''))
const badgeSize = computed(() => Math.max(12, Math.round(props.size * 0.44)))
</script>

<template>
  <span class="token-icon" :style="{ width: size + 'px', height: size + 'px' }" :title="chain ? `${symbol ?? ''} on ${chain}`.trim() : undefined">
    <img v-if="src" :src="src" :width="size" :height="size" alt="" class="rounded-full" />
    <span v-else class="mono grid h-full w-full place-items-center rounded-full bg-raised text-soft" :style="{ fontSize: size * 0.42 + 'px' }">{{ letter }}</span>
    <span v-if="chain" class="chain-badge" :style="{ width: badgeSize + 'px', height: badgeSize + 'px' }">
      <img v-if="badge" :src="badge" :width="badgeSize" :height="badgeSize" alt="" />
      <span v-else class="mono grid h-full w-full place-items-center text-soft" :style="{ fontSize: badgeSize * 0.55 + 'px' }">{{ chain.slice(0, 1).toUpperCase() }}</span>
    </span>
  </span>
</template>

<style scoped>
.token-icon {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
  vertical-align: middle;
}
.chain-badge {
  position: absolute;
  right: -3px;
  bottom: -3px;
  overflow: hidden;
  border-radius: 28%;
  background: var(--raised);
  /* A ring in the colour behind it, so the badge reads as a separate mark. */
  box-shadow: 0 0 0 2px var(--icon-ring, var(--surface));
}
.chain-badge img {
  display: block;
}
</style>
