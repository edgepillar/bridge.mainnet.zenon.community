<script setup lang="ts">
// Affiliate links: the original's format, so old links keep working. The
// orchestrator pays the unwrapper 1% extra and the referrer 2%, on wZNN and
// wQSR unwraps where bridge metadata turns the program on.
import { computed, ref, watch } from 'vue'
import { Copy, Check, Share2, Gift, Loader2 } from 'lucide-vue-next'
import Address from '../components/Address.vue'
import Amount from '../components/Amount.vue'
import StatusChip from '../components/StatusChip.vue'
import { syrius, api } from '../state/zenon.ts'
import { bridge } from '../state/bridge.ts'
import { referrer, clearReferral } from '../state/referral.ts'
import { linkFor } from '../core/referral.ts'
import { isAddress } from '../znn/primitives.ts'
import { isAffiliateEntry, unwrapStatus } from '../core/status.ts'
import { evmChain, config } from '../config.ts'
import type { UnwrapRequest } from '../znn/api.ts'

const input = ref('')
const address = computed(() => (input.value.trim() || syrius.address || '').trim())
const valid = computed(() => isAddress(address.value))
const base = computed(() => `${location.origin}${import.meta.env.BASE_URL}`)
const link = computed(() => (valid.value ? linkFor(address.value, base.value) : ''))

const copied = ref(false)
async function copy() {
  try {
    await navigator.clipboard.writeText(link.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    /* clipboard blocked */
  }
}
const canShare = typeof navigator !== 'undefined' && 'share' in navigator
function share() {
  void navigator.share?.({ title: 'Zenon bridge', url: link.value }).catch(() => undefined)
}

const programs = computed(() =>
  Object.entries(bridge.meta.affiliateProgram?.networks ?? {})
    .filter(([, n]) => (n.startingHeight ?? 0) > 0)
    .map(([id, n]) => ({ name: evmChain(Number(id)).name, tokens: ['wZNN', 'wQSR'].filter((s) => n[s] === true) })),
)

// What this address has earned as a referrer.
const earned = ref<UnwrapRequest[] | null>(null)
const loadingEarned = ref(false)
watch(
  () => [address.value, valid.value],
  async () => {
    earned.value = null
    if (!valid.value || !api.value) return
    loadingEarned.value = true
    try {
      const page = await api.value.unwrapsTo(address.value, 0, 100)
      earned.value = page.list.filter((u) => isAffiliateEntry(u.logIndex))
    } catch {
      earned.value = []
    } finally {
      loadingEarned.value = false
    }
  },
  { immediate: true },
)
const momentumSeconds = computed(() => bridge.orch?.estimatedMomentumTime ?? 10)
</script>

<template>
  <section class="rise mx-auto grid max-w-[640px] grid-cols-1 gap-5">
    <div>
      <h1 class="text-2xl font-semibold">Affiliate</h1>
      <p class="mt-1 text-soft">Unwraps through your link pay the sender 1% extra and you 2%.</p>
    </div>

    <div class="panel grid min-w-0 grid-cols-1 gap-4 p-4 md:p-5">
      <label class="grid min-w-0 grid-cols-1 gap-2">
        <span class="label">Your Zenon address</span>
        <input v-model="input" class="field mono truncate text-sm" :placeholder="syrius.address ?? 'z1…'" spellcheck="false" autocomplete="off" />
      </label>
      <div v-if="input && !valid" class="text-sm text-danger">Not a Zenon address</div>
      <div v-if="link" class="well flex min-w-0 items-center gap-2 p-2 pl-3">
        <span class="mono min-w-0 flex-1 truncate text-sm text-soft" :title="link">{{ link }}</span>
        <button class="btn btn-plasma btn-sm" @click="copy"><Check v-if="copied" :size="15" /><Copy v-else :size="15" />{{ copied ? 'Copied' : 'Copy' }}</button>
        <button v-if="canShare" class="btn btn-sm !px-3" aria-label="Share" @click="share"><Share2 :size="15" /></button>
      </div>
      <div class="flex flex-wrap gap-2 text-sm text-dim">
        <span v-if="!programs.length">Program off on every network</span>
        <span v-for="p in programs" :key="p.name" class="chip chip-dim">{{ p.name }}: {{ p.tokens.join(', ') || 'none' }}</span>
      </div>
    </div>

    <div class="panel min-w-0 p-4 md:p-5">
      <div class="label mb-3">Referral on this browser</div>
      <div v-if="referrer" class="flex flex-wrap items-center gap-3">
        <Gift :size="18" class="text-new" />
        <Address :value="referrer" :href="config.zenonExplorerAddress(referrer)" />
        <button class="btn btn-sm ml-auto" @click="clearReferral">Clear</button>
      </div>
      <p v-else class="text-soft">None</p>
    </div>

    <div v-if="valid" class="panel min-w-0 p-4 md:p-5">
      <div class="label mb-3">Earned as referrer</div>
      <div v-if="loadingEarned" class="flex items-center gap-2 text-soft"><Loader2 :size="15" class="spin" />Loading</div>
      <p v-else-if="!earned?.length" class="text-soft">None yet</p>
      <div v-else class="grid gap-2">
        <div v-for="u in earned" :key="u.transactionHash + u.logIndex" class="flex flex-wrap items-center gap-3 text-sm">
          <Amount :value="u.amount" :decimals="u.token?.decimals ?? 8" :symbol="u.token?.symbol" />
          <span class="text-dim">from {{ evmChain(u.chainId).name }}</span>
          <StatusChip v-bind="unwrapStatus({ ...u, momentumSeconds })" class="ml-auto" />
        </div>
      </div>
    </div>
  </section>
</template>
