<script setup lang="ts">
// Token and network marks from the original deployment; a lettered disc for
// anything else.
import { computed } from 'vue'
import znn from '../assets/znn.svg'
import qsr from '../assets/qsr.svg'
import wznn from '../assets/wznn.svg'
import wqsr from '../assets/wqsr.svg'
import eth from '../assets/eth.svg'
import bnb from '../assets/bnb.svg'
import zenon from '../assets/zenon.svg'

const props = withDefaults(defineProps<{ symbol?: string; network?: string; size?: number }>(), { size: 24 })
const MAP: Record<string, string> = { ZNN: znn, QSR: qsr, WZNN: wznn, WQSR: wqsr, ETH: eth, WETH: eth, BNB: bnb }
const src = computed(() => {
  if (props.network !== undefined) {
    const n = props.network.toLowerCase()
    if (n.includes('zenon')) return zenon
    if (n.includes('bnb') || n.includes('bsc') || n.includes('binance')) return bnb
    if (n.includes('eth') || n.includes('anvil')) return eth
    return ''
  }
  // Only marks we have; anything else (WBTC, an LP token) gets a lettered disc
  // rather than a mark that reads as ZNN.
  return MAP[(props.symbol ?? '').toUpperCase()] ?? ''
})
const letter = computed(() => (props.symbol || props.network || '?').replace(/^w/i, '').slice(0, 1).toUpperCase())
</script>

<template>
  <img v-if="src" :src="src" :width="size" :height="size" alt="" class="shrink-0 rounded-full" />
  <span
    v-else
    class="mono grid shrink-0 place-items-center rounded-full bg-raised text-soft"
    :style="{ width: size + 'px', height: size + 'px', fontSize: size * 0.42 + 'px' }"
    >{{ letter }}</span
  >
</template>
