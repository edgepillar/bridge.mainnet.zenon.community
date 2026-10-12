<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Sun, Moon } from 'lucide-vue-next'
import WalletBar from './components/WalletBar.vue'
import Banner from './components/Banner.vue'
import Address from './components/Address.vue'
import StatusChip from './components/StatusChip.vue'
import BridgeView from './views/BridgeView.vue'
import ActivityView from './views/ActivityView.vue'
import LiquidityView from './views/LiquidityView.vue'
import StatsView from './views/StatsView.vue'
import AffiliateView from './views/AffiliateView.vue'
import zenonMark from './assets/zenon.svg'
import { route, ROUTES, go } from './state/router.ts'
import { theme, toggleTheme } from './state/theme.ts'
import { node, syrius, wrongZenonChain, hostOf, chainId, networkLabel, requestWalletNode, walletNode } from './state/zenon.ts'
import { bridge, bridgeDown } from './state/bridge.ts'
import { referrer, clearReferral } from './state/referral.ts'
import { actionCount } from './state/activity.ts'
import { toasts, dismiss } from './state/toasts.ts'
import { zenonNetworkName } from './config.ts'

const views = { bridge: BridgeView, activity: ActivityView, liquidity: LiquidityView, stats: StatsView, affiliate: AffiliateView }
const current = computed(() => views[route.value])

const flash = ref(false)
watch(
  () => node.height,
  () => {
    flash.value = false
    requestAnimationFrame(() => (flash.value = true))
  },
)
const noticeHidden = ref(false)
watch(
  () => node.notice,
  () => (noticeHidden.value = false),
)
const downMessage = computed(() => {
  if (bridge.health?.message && bridgeDown()) return bridge.health.message
  if (bridge.info?.halted) return 'The bridge is halted. Transfers are paused.'
  if (bridge.info?.allowKeyGen) return 'Orchestrators are generating a new key. Transfers wait until it is done.'
  return ''
})
// The header's one-word verdict. The contract's own switches answer before
// the scan of orchestrator blocks has finished.
const status = computed(() => {
  const h = bridge.health
  if (h) return { tone: h.tone, label: h.label, spin: false }
  if (bridge.info?.halted) return { tone: 'danger' as const, label: 'Halted', spin: false }
  if (bridge.info?.allowKeyGen) return { tone: 'warn' as const, label: 'Key generation', spin: false }
  return { tone: 'dim' as const, label: 'Checking', spin: true }
})
</script>

<template>
  <div class="flex min-h-dvh flex-col">
    <div class="aurora" aria-hidden="true"><i /><i /><i /></div>
    <header class="bar sticky top-0 z-30">
      <div class="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 md:gap-6 md:px-8">
        <a href="#/" class="flex shrink-0 items-center gap-2.5" @click.prevent="go('bridge')">
          <img :src="zenonMark" width="28" height="28" alt="" />
          <span class="hidden text-[17px] font-semibold tracking-tight md:inline">Bridge</span>
        </a>
        <a href="#/stats" class="status" data-testid="bridge-status" :title="'Bridge status: ' + status.label">
          <StatusChip :tone="status.tone" :label="status.label" :spin="status.spin" />
        </a>
        <span v-if="chainId() !== 1" class="chip chip-warn mono hidden sm:inline-flex" data-testid="network-chip">{{ networkLabel() }} {{ chainId() }}</span>
        <nav class="hidden items-center gap-1 md:flex">
          <a
            v-for="r in ROUTES"
            :key="r.id"
            :href="r.id === 'bridge' ? '#/' : '#/' + r.id"
            class="nav-link"
            :class="{ active: route === r.id }"
          >
            {{ r.label }}<span v-if="r.id === 'activity' && actionCount()" class="dot-count">{{ actionCount() }}</span>
          </a>
        </nav>
        <div class="flex-1" />
        <a
          href="#/stats"
          class="momentum hidden items-center gap-2 sm:flex"
          :class="node.conn === 'open' ? 'text-ok' : 'text-warn'"
          :title="'Momentum height, read from ' + hostOf(node.url)"
        >
          <span class="live-dot" />
          <span class="mono text-sm text-soft" :class="{ flash }">{{ node.height ? node.height.toLocaleString('en-US') : '…' }}</span>
        </a>
        <WalletBar />
        <button class="btn btn-ghost btn-sm !w-11 !px-0" :aria-label="theme === 'dark' ? 'Light theme' : 'Dark theme'" @click="toggleTheme">
          <Sun v-if="theme === 'dark'" :size="18" /><Moon v-else :size="18" />
        </button>
      </div>
      <nav class="tabs flex gap-1 overflow-x-auto px-4 pb-2 md:hidden">
        <a v-for="r in ROUTES" :key="r.id" :href="r.id === 'bridge' ? '#/' : '#/' + r.id" class="nav-link" :class="{ active: route === r.id }">
          {{ r.label }}<span v-if="r.id === 'activity' && actionCount()" class="dot-count">{{ actionCount() }}</span>
        </a>
      </nav>
    </header>

    <div class="mx-auto mt-4 grid w-full max-w-6xl gap-2 px-4 md:px-8">
      <Banner v-if="downMessage && route !== 'stats'" tone="danger">
        <strong>{{ networkLabel() }} bridge is down.</strong> {{ downMessage }}
        <template #action><a href="#/stats" class="btn btn-ghost btn-sm -my-1 !text-inherit">Status</a></template>
      </Banner>
      <Banner v-if="wrongZenonChain()" tone="wait">
        <span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>Syrius</span><span class="chip chip-dim mono">{{ zenonNetworkName(syrius.chainId!) }} {{ syrius.chainId }}</span>
          <span>Page</span><span class="chip chip-dim mono">{{ networkLabel() }} {{ chainId() }}</span>
        </span>
        <template #action>
          <button class="btn btn-sm -my-1" data-testid="use-wallet-node" :disabled="walletNode.checking" @click="requestWalletNode">Use Syrius node</button>
        </template>
      </Banner>
      <Banner v-if="walletNode.problem" tone="warn" dismissable @dismiss="walletNode.problem = ''">{{ walletNode.problem }}.</Banner>
      <Banner v-if="node.notice && !noticeHidden" tone="wait" dismissable @dismiss="noticeHidden = true">{{ node.notice }}</Banner>
      <Banner v-if="referrer" tone="new">
        Referral from <Address :value="referrer" :copy="false" class="text-fg" />. Unwraps of wZNN and wQSR earn 1% extra.
        <template #action><button class="btn btn-ghost btn-sm -my-1 !text-inherit" @click="clearReferral">Clear</button></template>
      </Banner>
    </div>

    <main class="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-16 md:px-8">
      <Transition name="fade" mode="out-in">
        <component :is="current" :key="route" />
      </Transition>
    </main>

    <div class="toasts" aria-live="polite">
      <TransitionGroup name="fade">
        <div v-for="t in toasts" :key="t.id" class="toast panel" :class="'toast-' + t.tone" @click="dismiss(t.id)">
          <span>{{ t.text }}</span>
          <a v-if="t.link" :href="t.link.href" target="_blank" rel="noopener" class="link ml-2" @click.stop>{{ t.link.label }}</a>
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>

<style scoped>
.bar {
  background: var(--bar-glass);
  backdrop-filter: blur(14px) saturate(1.4);
  border-bottom: 1px solid var(--line);
}
.nav-link {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 0 12px;
  border-radius: var(--radius);
  color: var(--soft);
  font-size: 15px;
  white-space: nowrap;
  transition:
    color 150ms var(--ease),
    background 150ms var(--ease);
}
.nav-link:hover {
  color: var(--fg);
  background: var(--raised);
}
.nav-link.active {
  color: var(--fg);
}
.nav-link.active::after {
  content: '';
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 2px;
  height: 2px;
  border-radius: 2px;
  background: var(--plasma);
}
.dot-count {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--warn);
  color: var(--on-plasma);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
}
.tabs {
  scrollbar-width: none;
}
.momentum {
  min-height: 44px;
  padding: 0 4px;
}
.status {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  min-height: 44px;
}
@media (min-width: 700px) {
  .status {
    margin-left: -12px;
  }
}
.toasts {
  position: fixed;
  right: 16px;
  bottom: 16px;
  left: 16px;
  z-index: 60;
  display: grid;
  justify-items: end;
  gap: 8px;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  max-width: 420px;
  padding: 12px 14px;
  font-size: 14px;
  border-left: 3px solid var(--dim);
  box-shadow: var(--edge), var(--shadow-pop);
  cursor: pointer;
}
.toast-ok {
  border-left-color: var(--ok);
}
.toast-wait {
  border-left-color: var(--wait);
}
.toast-warn {
  border-left-color: var(--warn);
}
.toast-danger {
  border-left-color: var(--danger);
}
</style>
