<script setup lang="ts">
import { ref } from 'vue'
import Modal from './Modal.vue'
import { TERMS, accept } from '../state/ack.ts'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; accepted: [] }>()
const agreed = ref(false)
function confirm() {
  accept()
  emit('accepted')
}
</script>

<template>
  <Modal :open="open" title="Before you start" @close="emit('close')">
    <ul class="grid gap-2 text-sm text-soft">
      <li v-for="(t, i) in TERMS" :key="i" class="flex gap-2"><span class="text-dim">·</span><span>{{ t }}</span></li>
    </ul>
    <label class="mt-4 flex min-h-[44px] cursor-pointer items-center gap-3 rounded-md p-2 text-sm hover:bg-raised">
      <input v-model="agreed" type="checkbox" data-testid="terms-all" class="h-4 w-4 shrink-0 accent-[var(--znn)]" />
      <span>I agree to all of the above</span>
    </label>
    <button data-testid="terms-continue" class="btn btn-plasma btn-block mt-3" :disabled="!agreed" @click="confirm">Continue</button>
  </Modal>
</template>
