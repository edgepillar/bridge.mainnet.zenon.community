<script setup lang="ts">
// An amount: mono, tabular, trailing zeros dimmed rather than rounded away.
import { computed } from 'vue'
import { formatUnits } from '../core/format.ts'

const props = withDefaults(defineProps<{ value: bigint; decimals: number; symbol?: string; max?: number }>(), { max: 6 })
const parts = computed(() => {
  const [w, f] = formatUnits(props.value, props.decimals, props.max).split('.')
  return { w, f: f ?? '' }
})
</script>

<template>
  <span class="mono whitespace-nowrap" :title="formatUnits(value, decimals, decimals) + (symbol ? ' ' + symbol : '')"
    >{{ parts.w }}<span v-if="parts.f" class="opacity-70">.{{ parts.f }}</span
    ><span v-if="symbol" class="ml-1 font-sans text-soft">{{ symbol }}</span></span
  >
</template>
