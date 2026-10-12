<script setup lang="ts">
import { ref, computed } from 'vue'
import Modal from './Modal.vue'
import { TERMS, accept } from '../state/ack.ts'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; accepted: [] }>()
const ticks = ref<boolean[]>(TERMS.map(() => false))
const all = computed(() => ticks.value.every(Boolean))
function confirm() {
  accept()
  emit('accepted')
}
</script>

<template>
  <Modal :open="open" title="Before you bridge" @close="emit('close')">
    <div class="grid gap-1">
      <label v-for="(t, i) in TERMS" :key="i" class="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-md p-2 text-sm text-soft hover:bg-raised">
        <input v-model="ticks[i]" type="checkbox" class="mt-0.5 h-4 w-4 shrink-0 accent-[var(--znn)]" />
        <span>{{ t }}</span>
      </label>
    </div>
    <div class="mt-4 flex gap-2">
      <button data-testid="terms-all" class="btn flex-1" @click="ticks = TERMS.map(() => true)">Tick all</button>
      <button data-testid="terms-continue" class="btn btn-plasma flex-1" :disabled="!all" @click="confirm">Continue</button>
    </div>
  </Modal>
</template>
