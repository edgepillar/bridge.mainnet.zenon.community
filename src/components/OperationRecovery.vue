<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Download } from '@lucide/vue'
import StatusChip from './StatusChip.vue'
import { operations, reviewHashlessOperation, rawJournal, resetUnreadableJournal, UNKNOWN_REVIEW_DELAY_SECONDS, type Operation } from '../state/operations.ts'
import { api, node } from '../state/zenon.ts'
import { readClient } from '../evm/client.ts'
import { walletForReads } from '../state/evm.ts'
import { nodeContext } from '../state/bridge.ts'
import { refreshActivity } from '../state/activity.ts'
import { toast, toastError } from '../state/toasts.ts'
import { evmChain, zenonNetworkName } from '../config.ts'
import type { Tone } from '../core/status.ts'

const unresolved = computed(() => operations.entries.filter((r) => ['awaiting-wallet', 'unknown', 'submitted', 'mismatch'].includes(r.state)))
const hashes = ref<Record<string, string>>({})
const busy = ref<Record<string, boolean>>({})
const messages = ref<Record<string, string>>({})
const acknowledged = ref<Record<string, boolean>>({})
const now = ref(Math.floor(Date.now() / 1000))
let timer: ReturnType<typeof setInterval>
onMounted(() => { timer = setInterval(() => { now.value = Math.floor(Date.now() / 1000) }, 1000) })
onUnmounted(() => clearInterval(timer))

const KIND: Record<string, string> = { 'zenon-send': 'Send', approve: 'Approval', unwrap: 'Unwrap', redeem: 'Redeem', swap: 'Swap', 'swap-approval': 'Approval', 'liquidity-approval': 'Approval', 'add-liquidity': 'Add liquidity' }
const STATE: Record<string, { tone: Tone; label: string }> = {
  'awaiting-wallet': { tone: 'wait', label: 'In wallet' },
  unknown: { tone: 'warn', label: 'No reply' },
  submitted: { tone: 'wait', label: 'Sent' },
  mismatch: { tone: 'danger', label: 'Differs' },
}
const kindOf = (o: Operation) => KIND[o.kind] ?? o.kind
const chainOf = (o: Operation) => (o.source === 'zenon' ? `${zenonNetworkName(o.chainId)} ${o.chainId}` : evmChain(o.chainId).name)
const canReview = (o: Operation) => o.state === 'unknown' && !o.hash && !o.reportedHashes?.length && !o.reviewedAt

async function review(operation: Operation) {
  busy.value[operation.id] = true
  try {
    await reviewHashlessOperation(operation.id, acknowledged.value[operation.id] === true)
    messages.value[operation.id] = 'Dismissed. The same send stays blocked.'
  } catch (error) { toastError(error) }
  finally { busy.value[operation.id] = false }
}
async function reconcile(operation: Operation) {
  const context = nodeContext(), a = api.value
  const current = () => context === nodeContext() && a === api.value
  busy.value[operation.id] = true
  try {
    const { reconcileEvm, reconcileZenon } = await import('../state/reconcile.ts')
    const hash = operation.hash ?? hashes.value[operation.id]?.trim()
    if (operation.state === 'mismatch') throw new Error('Wallet sent different details. Contact wallet support.')
    if (operation.source === 'zenon') {
      if (operation.chainId !== node.chainId || node.conn !== 'open') throw new Error('Connect to the Zenon network it was sent on')
      const resolved = await reconcileZenon(a, operation, hash, current)
      messages.value[operation.id] = resolved ? 'Confirmed' : 'Not confirmed yet. Check again later.'
    } else {
      const resolved = await reconcileEvm(readClient(operation.chainId, walletForReads()), operation, hash, current)
      messages.value[operation.id] = resolved ? 'Confirmed' : 'Not confirmed yet. Check again later.'
    }
    await refreshActivity()
  } catch (error) { toastError(error) }
  finally { busy.value[operation.id] = false }
}

const unreadable = computed(() => operations.error.startsWith("Saved history can't be read"))
function exportAndReset() {
  const text = rawJournal()
  if (text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `bridge-history-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  if (resetUnreadableJournal()) toast('History reset', 'ok')
  else toast("History still can't be read", 'danger')
}
</script>

<template>
  <section v-if="operations.error || unresolved.length" class="panel p-4" aria-label="Unconfirmed sends" data-testid="operation-recovery">
    <h2 class="font-semibold">Unconfirmed</h2>
    <p v-if="unresolved.length" class="mt-1 text-sm text-soft">Your wallet didn't confirm these. They may still be sent.</p>
    <div v-if="operations.error" class="mt-2 flex flex-wrap items-center gap-3 text-sm text-danger">
      <span class="flex-1">{{ operations.error }}</span>
      <button v-if="unreadable" class="btn btn-sm" data-testid="journal-reset" @click="exportAndReset"><Download :size="14" />Download and reset</button>
    </div>
    <div v-for="operation in unresolved" :key="operation.id" class="mt-3 grid min-w-0 gap-2 border-t border-line pt-3">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="font-medium">{{ kindOf(operation) }}</span>
        <span class="text-dim">{{ chainOf(operation) }}</span>
        <StatusChip v-bind="STATE[operation.state] ?? { tone: 'dim', label: operation.state }" />
      </div>
      <code v-if="operation.hash" class="break-all text-xs text-soft">{{ operation.hash }}</code>
      <label v-else-if="operation.state !== 'mismatch'" class="grid gap-1 text-sm"><span class="text-dim">Transaction hash, if your wallet shows one</span><input v-model="hashes[operation.id]" class="field mono text-xs" autocomplete="off" spellcheck="false" :disabled="operation.state === 'awaiting-wallet' || busy[operation.id]" /></label>
      <div class="flex flex-wrap gap-2">
        <button v-if="operation.state !== 'mismatch'" class="btn btn-sm" :disabled="operation.state === 'awaiting-wallet' || busy[operation.id]" @click="reconcile(operation)">{{ busy[operation.id] ? 'Checking' : 'Check' }}</button>
      </div>
      <p v-if="operation.state === 'mismatch'" class="text-sm text-danger">Wallet sent different details. Contact wallet support.</p>
      <div v-if="canReview(operation)" class="grid gap-2 text-sm" data-testid="hashless-review">
        <label class="flex items-start gap-2"><input v-model="acknowledged[operation.id]" type="checkbox" :disabled="busy[operation.id]" data-testid="hashless-review-ack" class="mt-0.5 accent-[var(--znn)]" /><span>Not in my wallet's pending or history</span></label>
        <button class="btn btn-sm justify-self-start" data-testid="hashless-review-action" :disabled="!acknowledged[operation.id] || busy[operation.id] || now - operation.createdAt < UNKNOWN_REVIEW_DELAY_SECONDS" @click="review(operation)">
          {{ now - operation.createdAt < UNKNOWN_REVIEW_DELAY_SECONDS ? `Dismiss in ${UNKNOWN_REVIEW_DELAY_SECONDS - (now - operation.createdAt)}s` : 'Dismiss' }}
        </button>
      </div>
      <p v-if="operation.reviewedAt && operation.state === 'unknown' && !operation.hash && !messages[operation.id]" class="text-sm text-soft">Dismissed. The same send stays blocked.</p>
      <p v-if="messages[operation.id]" class="text-sm text-soft" role="status">{{ messages[operation.id] }}</p>
    </div>
  </section>
</template>
