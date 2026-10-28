<script setup lang="ts">
import { computed } from 'vue'
import { formatUnits } from '../core/format.ts'

const props = withDefaults(defineProps<{ value: bigint | null; decimals: number; symbol?: string; max?: number }>(), { max: 6 })
const text = computed(() => (props.value === null ? '' : formatUnits(props.value, props.decimals, props.max)))
const full = computed(() => (props.value === null ? '' : formatUnits(props.value, props.decimals, props.decimals) + (props.symbol ? ' ' + props.symbol : '')))
</script>

<template>
  <span class="mono whitespace-nowrap" :title="full || undefined"><span v-if="value === null" class="text-dim">–</span><template v-else>{{ text }}</template><span v-if="symbol" class="ml-1 font-sans text-soft">{{ symbol }}</span></span>
</template>
