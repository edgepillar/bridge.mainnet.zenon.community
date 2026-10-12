<script setup lang="ts">
// A bottom sheet on a phone, a centred dialog above the breakpoint.
import { X } from 'lucide-vue-next'
defineProps<{ open: boolean; title: string; wide?: boolean }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="open"
        class="fixed inset-0 z-50 grid place-items-end bg-black/55 backdrop-blur-sm md:place-items-center"
        @click.self="emit('close')"
        @keydown.esc="emit('close')"
      >
        <div class="sheet panel w-full" :class="wide ? 'md:w-[560px]' : 'md:w-[440px]'" role="dialog" :aria-label="title">
          <div class="flex items-center justify-between gap-4 px-5 pt-4 pb-2">
            <h2 class="text-lg font-semibold">{{ title }}</h2>
            <button class="btn btn-ghost btn-sm !px-2" aria-label="Close" @click="emit('close')"><X :size="18" /></button>
          </div>
          <div class="max-h-[78dvh] overflow-y-auto px-5 pb-5"><slot /></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.sheet {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
  box-shadow: var(--edge), var(--shadow-pop);
}
@media (min-width: 700px) {
  .sheet {
    border-radius: calc(var(--radius) * 2);
  }
}
.modal-enter-active,
.modal-leave-active {
  transition: opacity 180ms var(--ease);
}
.modal-enter-active .sheet,
.modal-leave-active .sheet {
  transition: transform 200ms var(--spring);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .sheet,
.modal-leave-to .sheet {
  transform: translateY(24px);
}
</style>
