<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch, type Component } from 'vue'
import { Sun, Moon, Ellipsis, ArrowLeftRight, History, Droplets, ChartNoAxesColumn, Gift, CodeXml } from '@lucide/vue'
import WalletBar from './components/WalletBar.vue'
import Starfield from './components/Starfield.vue'
import Banner from './components/Banner.vue'
import Address from './components/Address.vue'
import StatusChip from './components/StatusChip.vue'
import zenonMark from './assets/zenon.svg'
import { route, NAV, go, type Route } from './state/router.ts'
import { theme, toggleTheme } from './state/theme.ts'
import { node, syrius, zenonChainMismatch, hostOf, chainId, networkLabel, requestWalletNode, walletNode, checkSyriusNetwork } from './state/zenon.ts'
import { bridge, bridgeDown, transferBlocker } from './state/bridge.ts'
import { referrer, clearReferral } from './state/referral.ts'
import { actionCount } from './state/activity.ts'
import { toasts, dismiss } from './state/toasts.ts'
import { config, zenonNetworkName } from './config.ts'
import { mode, swapMessage } from './state/swap.ts'

const views = {
  bridge: defineAsyncComponent(() => import('./views/BridgeView.vue')),
  activity: defineAsyncComponent(() => import('./views/ActivityView.vue')),
  liquidity: defineAsyncComponent(() => import('./views/LiquidityView.vue')),
  stats: defineAsyncComponent(() => import('./views/StatsView.vue')),
  affiliate: defineAsyncComponent(() => import('./views/AffiliateView.vue')),
}
const current = computed(() => views[route.value])
// A phone's tab bar has room for a mark, not for four words.
const ICONS: Record<Route, Component> = { bridge: ArrowLeftRight, activity: History, liquidity: Droplets, stats: ChartNoAxesColumn, affiliate: Gift }
const hrefOf = (id: Route) => (id === 'bridge' ? '#/' : '#/' + id)

const more = ref(false)
const flash = ref(false)
watch(
  () => node.height,
  () => {
    flash.value = false
    requestAnimationFrame(() => (flash.value = true))
  },
)
const noticeHidden = ref(false)
// Closing the bridge banner holds until the bridge's state changes or the page is loaded again. The chip in the header stays.
const downHidden = ref(false)

const chainMismatch = ref(false)
let mismatchTimer: ReturnType<typeof setTimeout> | undefined
watch(zenonChainMismatch, (now) => {
  clearTimeout(mismatchTimer)
  if (!now) chainMismatch.value = false
  else mismatchTimer = setTimeout(() => (chainMismatch.value = zenonChainMismatch()), 1500)
}, { immediate: true })

// A banner that comes or goes opens or closes its own height, gap included,
// in step with the page fade. Removed at once, it moved everything under it
// by its height in one frame (the stalled banner leaving for Status).
const BANNER_GAP = 8
const BANNER_SIZE = ['height', 'paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth', 'marginTop', 'opacity', 'overflow', 'transition'] as const
function bannerShut(s: CSSStyleDeclaration) {
  s.height = '0px'
  s.paddingTop = s.paddingBottom = s.borderTopWidth = s.borderBottomWidth = '0px'
  s.marginTop = `-${BANNER_GAP}px`
  s.opacity = '0'
}
function bannerAnimate(el: Element, open: boolean, done: () => void) {
  const e = el as HTMLElement, s = e.style
  const height = e.offsetHeight
  s.overflow = 'hidden'
  if (open) bannerShut(s)
  else s.height = `${height}px`
  void e.offsetHeight
  s.transition = ['height', 'padding', 'border-width', 'margin-top', 'opacity'].map((p) => `${p} 180ms var(--ease)`).join(', ')
  if (open) {
    s.height = `${height}px`
    for (const k of ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth', 'marginTop', 'opacity'] as const) s[k] = ''
  } else bannerShut(s)
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    if (open) for (const k of BANNER_SIZE) s[k] = ''
    done()
  }
  e.addEventListener('transitionend', (ev) => ev.target === e && ev.propertyName === 'height' && finish())
  setTimeout(finish, 260)
}
const bannerEnter = (el: Element, done: () => void) => bannerAnimate(el, true, done)
const bannerLeave = (el: Element, done: () => void) => bannerAnimate(el, false, done)
watch(
  () => bridge.health?.state,
  () => (downHidden.value = false),
)
watch(
  () => node.notice,
  () => (noticeHidden.value = false),
)
// The bridge's state says nothing about a swap, and a swap's routers nothing about the bridge.
const swapping = computed(() => route.value === 'bridge' && mode.value === 'swap')
// One down state, said once. The header chip links to Status, which has the
// detail, so the banner carries only what it means for a send.
const downBanner = computed(() => {
  const blocker = transferBlocker()
  if (blocker && !['Bridge is unavailable', 'Bridge is paused'].includes(blocker)) return { title: blocker + '.', body: '' }
  if (bridge.info?.halted) return { title: 'Bridge is halted.', body: 'Transfers are paused.' }
  if (bridge.info?.allowKeyGen) return { title: 'New key in progress.', body: 'Transfers wait.' }
  if (bridge.health?.state === 'down') return { title: 'Bridge is stalled.', body: config.swap ? 'Swaps still work.' : '' }
  if (bridge.health?.message && bridgeDown()) return { title: bridge.health.message, body: '' }
  return null
})
// The header's one-word verdict. The contract's own switches answer before
// the scan of orchestrator blocks has finished.
const status = computed(() => {
  const h = bridge.health
  const blocker = transferBlocker()
  if (blocker && !['Bridge is unavailable', 'Bridge is paused'].includes(blocker)) return { tone: 'dim' as const, label: 'Unavailable', spin: !bridge.loaded }
  if (h) return { tone: h.tone, label: h.label, spin: false }
  if (bridge.info?.halted) return { tone: 'danger' as const, label: 'Halted', spin: false }
  if (bridge.info?.allowKeyGen) return { tone: 'warn' as const, label: 'Key generation', spin: false }
  return { tone: 'dim' as const, label: 'Checking', spin: true }
})
</script>

<template>
  <div class="flex min-h-dvh flex-col">
    <Starfield />
    <header class="bar sticky top-0 z-30">
      <div class="mx-auto flex h-[72px] max-w-6xl items-center gap-2 px-4 md:gap-5 md:px-8">
        <a href="#/" class="brand" @click.prevent="go('bridge')">
          <img :src="zenonMark" width="30" height="30" alt="" />
          <span class="hidden text-[19px] font-semibold tracking-tight md:inline">Bridge</span>
        </a>
        <a href="#/stats" class="status" data-testid="bridge-status" :title="'Bridge status: ' + status.label">
          <StatusChip :tone="status.tone" :label="status.label" :spin="status.spin" />
        </a>
        <span v-if="chainId() !== 1" class="chip chip-warn mono hidden sm:inline-flex" data-testid="network-chip">{{ networkLabel() }} {{ chainId() }}</span>
        <nav class="ml-2 hidden items-center gap-1 xl:flex">
          <a v-for="r in NAV" :key="r.id" :href="hrefOf(r.id)" class="nav-link" :class="{ active: route === r.id }" :aria-current="route === r.id ? 'page' : undefined">
            {{ r.label }}<span v-if="r.id === 'activity' && actionCount()" class="dot-count">{{ actionCount() }}</span>
          </a>
        </nav>
        <div class="flex-1" />
        <WalletBar />
        <div class="relative">
          <button class="icon-btn" aria-label="More" :aria-expanded="more" data-testid="more-menu" @click="more = !more"><Ellipsis :size="18" /></button>
          <div v-if="more" class="backdrop" @click="more = false" />
          <Transition name="pop">
            <div v-if="more" class="popover more">
              <button class="menu-row" @click="toggleTheme">
                <Sun v-if="theme === 'dark'" :size="15" /><Moon v-else :size="15" />
                <span class="flex-1">{{ theme === 'dark' ? 'Light theme' : 'Dark theme' }}</span>
              </button>
              <a class="menu-row" href="#/stats" :title="'Read from ' + hostOf(node.url)" @click="more = false">
                <span class="live-dot" :class="node.conn === 'open' ? 'text-ok' : 'text-warn'" />
                <span class="flex-1">Momentum</span>
                <span class="mono text-soft" :class="{ flash }">{{ node.height ? node.height.toLocaleString('en-US') : '…' }}</span>
              </a>
              <a class="menu-row" href="https://github.com/sol-znn/bridge.mainnet.zenon.community" target="_blank" rel="noopener">
                <CodeXml :size="15" /><span class="flex-1">Source</span>
              </a>
              <a class="menu-row" href="#/affiliate" data-testid="menu-referral" @click="more = false">
                <Gift :size="15" /><span class="flex-1">Referral</span>
              </a>
            </div>
          </Transition>
        </div>
      </div>
    </header>

    <TransitionGroup tag="div" class="mx-auto mt-2 grid w-full max-w-[640px] grid-cols-1 gap-2 px-4" :css="false" @enter="bannerEnter" @leave="bannerLeave">
      <Banner v-if="swapping && swapMessage" key="swap" tone="danger">
        <strong>Swaps are unavailable.</strong> {{ swapMessage }}
      </Banner>
      <Banner v-if="downBanner && route !== 'stats' && !swapping && !downHidden" key="down" tone="danger" dismissable data-testid="down-banner" @dismiss="downHidden = true">
        <strong>{{ downBanner.title }}</strong> {{ downBanner.body }}
      </Banner>
      <Banner v-if="syrius.app && syrius.address && syrius.chainId === null" key="app-network" tone="wait" data-testid="app-network">
        Check the network Syrius is on.
        <template #action>
          <button class="btn btn-sm -my-1" @click="checkSyriusNetwork">Check network</button>
        </template>
      </Banner>
      <Banner v-else-if="chainMismatch" key="wrong-chain" tone="wait">
        <span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>Syrius</span><span class="chip chip-dim mono">{{ zenonNetworkName(syrius.chainId!) }} {{ syrius.chainId }}</span>
          <span>Page</span><span class="chip chip-dim mono">{{ networkLabel() }} {{ chainId() }}</span>
        </span>
        <template #action>
          <button v-if="syrius.app" class="btn btn-sm -my-1" @click="checkSyriusNetwork">Check again</button>
          <button v-else class="btn btn-sm -my-1" data-testid="use-wallet-node" :disabled="walletNode.checking" @click="requestWalletNode">Use Syrius node</button>
        </template>
      </Banner>
      <Banner v-if="walletNode.problem" key="node-problem" tone="warn" dismissable @dismiss="walletNode.problem = ''">{{ walletNode.problem }}.</Banner>
      <Banner v-if="node.notice && !noticeHidden" key="notice" tone="wait" dismissable @dismiss="noticeHidden = true">{{ node.notice }}</Banner>
      <Banner v-if="referrer" key="referrer" tone="new">
        Referral from <Address :value="referrer" :copy="false" class="text-fg" />
        <template #action><button class="btn btn-ghost btn-sm -my-1 !text-inherit" @click="clearReferral">Clear</button></template>
      </Banner>
    </TransitionGroup>

    <main class="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-28 md:px-8 md:pb-16">
      <Transition name="fade" mode="out-in">
        <component :is="current" :key="route" />
      </Transition>
    </main>

    <!-- A phone navigates from the bottom, where the thumb is. -->
    <nav class="dock xl:hidden" aria-label="Sections">
      <a v-for="r in NAV" :key="r.id" :href="hrefOf(r.id)" class="dock-link" :class="{ active: route === r.id }" :aria-label="r.label" :aria-current="route === r.id ? 'page' : undefined">
        <component :is="ICONS[r.id]" :size="20" />
        <span v-if="r.id === 'activity' && actionCount()" class="dot-count dock-count">{{ actionCount() }}</span>
      </a>
    </nav>

    <div class="toasts" aria-live="polite">
      <TransitionGroup name="fade">
        <div v-for="t in toasts" :key="t.id" class="toast" :class="'toast-' + t.tone" role="status" @click="dismiss(t.id)">
          <span>{{ t.text }}</span>
          <a v-if="t.link" :href="t.link.href" target="_blank" rel="noopener" class="link ml-2" @click.stop>{{ t.link.label }}</a>
          <span class="toast-bar" :style="{ animationDuration: t.ms + 'ms' }" aria-hidden="true" />
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>

<style scoped>
/* The header floats on the starfield: no line under it, only a blur for the
   content that scrolls beneath. */
.bar::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  background: linear-gradient(var(--bar-glass), transparent);
  backdrop-filter: blur(8px);
  -webkit-mask-image: linear-gradient(#000 60%, transparent);
  mask-image: linear-gradient(#000 60%, transparent);
  pointer-events: none;
}
.brand {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  transition: transform 220ms var(--spring);
}
.brand:hover {
  transform: scale(1.03);
}
.brand img {
  filter: drop-shadow(0 0 10px color-mix(in srgb, var(--znn) 30%, transparent));
}
.nav-link {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 0 12px;
  border-radius: 999px;
  color: var(--dim);
  font-size: 15px;
  white-space: nowrap;
  transition: color 180ms var(--ease);
}
.nav-link:hover {
  color: var(--fg);
}
.nav-link.active {
  color: var(--fg);
}
.nav-link::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 6px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--znn);
  opacity: 0;
  transform: translateX(-50%) scale(0);
  transition:
    opacity 180ms var(--ease),
    transform 260ms var(--spring);
}
.nav-link.active::after {
  opacity: 1;
  transform: translateX(-50%) scale(1);
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
.status {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  min-height: 44px;
}
.more {
  right: 0;
  top: calc(100% + 10px);
  width: 240px;
}
.dock {
  position: fixed;
  right: 12px;
  bottom: 12px;
  left: 12px;
  z-index: 30;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  padding: 6px;
  border-radius: 22px;
  background: color-mix(in srgb, var(--surface) 86%, transparent);
  backdrop-filter: blur(14px);
  border: 1px solid var(--line);
  box-shadow: var(--edge), var(--shadow-pop);
}
@media (min-width: 1280px) {
  .dock {
    display: none;
  }
}
.dock-link {
  position: relative;
  display: grid;
  place-items: center;
  height: 48px;
  border-radius: 16px;
  color: var(--dim);
  transition:
    color 180ms var(--ease),
    background 180ms var(--ease),
    transform 220ms var(--spring);
}
.dock-link:active {
  transform: scale(0.92);
}
.dock-link.active {
  color: var(--znn-ink);
  background: var(--ok-bg);
}
.dock-count {
  position: absolute;
  top: 6px;
  right: calc(50% - 22px);
}
.toasts {
  position: fixed;
  right: 16px;
  bottom: 88px;
  left: 16px;
  z-index: 60;
  display: grid;
  justify-items: end;
  gap: 8px;
  pointer-events: none;
}
@media (min-width: 1280px) {
  .toasts {
    bottom: 20px;
  }
}
/* One toast at a time, with a bar that drains while it stays: the reader sees
   how long it has without a close button to aim for. */
.toast {
  --tone: var(--dim);
  position: relative;
  overflow: hidden;
  pointer-events: auto;
  max-width: 420px;
  padding: 12px 16px 14px;
  font-size: 14px;
  border-radius: 16px;
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  backdrop-filter: blur(14px);
  border: 1px solid var(--line);
  box-shadow: var(--edge), var(--shadow-pop);
  cursor: pointer;
}
.toast-ok {
  --tone: var(--ok);
}
.toast-wait {
  --tone: var(--wait);
}
.toast-warn {
  --tone: var(--warn);
}
.toast-danger {
  --tone: var(--danger);
}
.toast-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: var(--tone);
  transform-origin: left;
  animation: toast-drain linear forwards;
}
@keyframes toast-drain {
  from {
    transform: scaleX(1);
  }
  to {
    transform: scaleX(0);
  }
}
</style>
