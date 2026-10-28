<script setup lang="ts">
// Bridge and network status, read from the chain. Orchestrator status is
// derived (core/orchestrators.ts): no monitoring service is involved.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RefreshCw, ExternalLink, ChevronDown, Check, Minus, ArrowUpRight, ArrowDownLeft } from '@lucide/vue'
import TokenIcon from '../components/TokenIcon.vue'
import Amount from '../components/Amount.vue'
import Address from '../components/Address.vue'
import StatusChip from '../components/StatusChip.vue'
import { bridge, loadBridge, loadHealth, nodeContext } from '../state/bridge.ts'
import { api, node, hostOf } from '../state/zenon.ts'
import { ACTIVE_WITHIN_S } from '../core/orchestrators.ts'
import { ago, duration } from '../core/format.ts'
import { config, evmAddressUrl, evmChain } from '../config.ts'
import type { LiquidityInfo } from '../znn/api.ts'

const totals = ref<{ wraps: number; unwraps: number } | null>(null)
const fees = ref<Record<string, bigint>>({})
const security = ref<{ guardians: string[]; administratorDelay: number; softDelay: number } | null>(null)
const liquidity = ref<LiquidityInfo | null>(null)
const loading = ref(false)
const extrasError = ref('')
const extrasReadAt = ref(0)
let request = 0, mounted = true
onUnmounted(() => { mounted = false; request++ })

async function loadExtras() {
  const a = api.value, context = nodeContext(), generation = ++request
  const current = () => mounted && generation === request && a === api.value && context === nodeContext()
  if (!a || !bridge.loaded) return
  loading.value = true
  extrasReadAt.value = 0
  try {
    const zts = [...new Set(bridge.routes.map((r) => r.pair.tokenStandard))]
    const [w, u, sec, liq, feeList] = await Promise.all([
      a.allWraps(0, 1),
      a.allUnwraps(0, 1),
      a.securityInfo(),
      a.liquidityInfo(),
      Promise.all(zts.map(async (z) => [z, await a.feeTokenPair(z)] as const)),
    ])
    if (!current()) return
    totals.value = { wraps: w.count, unwraps: u.count }
    security.value = sec
    liquidity.value = liq
    fees.value = Object.fromEntries(feeList)
    extrasReadAt.value = Date.now()
    extrasError.value = ''
  } catch {
    if (current()) extrasError.value = 'Some figures unavailable. Showing the last read.'
  } finally {
    if (current()) loading.value = false
  }
}

onMounted(() => {
  if (bridge.loaded) void loadExtras()
})
watch(
  () => [bridge.loaded, nodeContext()],
  () => {
    request++
    totals.value = null; security.value = null; liquidity.value = null; fees.value = {}; extrasReadAt.value = 0; loading.value = false
    if (bridge.loaded) void loadExtras()
  },
  { flush: 'sync' },
)

async function refresh() {
  await loadBridge()
  await Promise.all([loadHealth(), loadExtras()])
}

const h = computed(() => bridge.health)
const now = computed(() => node.timestamp || Date.now() / 1000)
const activeCount = computed(() => (h.value?.orchestrators ?? []).filter((o) => now.value - o.lastSeen <= ACTIVE_WITHIN_S).length)
const zenonTokens = computed(() => {
  const m = new Map<string, { symbol: string; decimals: number }>()
  for (const r of bridge.routes) if (r.zts) m.set(r.pair.tokenStandard, { symbol: r.zts.symbol, decimals: r.zts.decimals })
  return m
})
const affiliate = computed(() => Object.entries(bridge.meta.affiliateProgram?.networks ?? {}))
const momentumTime = computed(() => bridge.orch?.estimatedMomentumTime || 10)
// What the state means, in the fewest words that are still true. The
// derivation samples recent blocks: it sees signing, not readiness.
const verdict = computed(() => {
  const s = h.value?.state
  if (h.value?.message) return h.value.message
  if (s === 'online') return 'Signing recently.'
  if (s === 'idle') return 'No signing lately.'
  return 'Status unknown.'
})
const iso = (ms: number) => new Date(ms).toISOString()
const halted = (v: boolean | null | undefined) =>
  v ? { tone: 'danger' as const, label: 'Halted' } : v === null || v === undefined ? { tone: 'dim' as const, label: 'Unknown' } : { tone: 'ok' as const, label: 'Running' }
const delays = (momentums: number, evmBlocks: bigint | number | undefined, blockTime: number | undefined) => {
  const blocks = evmBlocks === undefined ? undefined : Number(evmBlocks)
  return {
    text: `${duration(momentums * momentumTime.value)} · ${blocks !== undefined && blockTime ? duration(blocks * blockTime) : '–'}`,
    title: `${momentums} momentums on Zenon · ${blocks ?? '–'} blocks on the EVM side`,
  }
}
</script>

<template>
  <section class="rise grid grid-cols-1 gap-6">
    <div class="flex items-center gap-3">
      <h1 class="text-2xl font-semibold">Status</h1>
      <button class="btn btn-ghost btn-sm" aria-label="Refresh" :disabled="loading || bridge.healthLoading" @click="refresh">
        <RefreshCw :size="15" :class="{ spin: loading || bridge.healthLoading }" />
      </button>
    </div>

    <!-- Orchestrators: the one question most people come here with. -->
    <div class="panel overflow-hidden">
      <div class="status-head" :class="'tone-' + (h?.tone ?? 'dim')">
        <div class="flex flex-wrap items-center gap-3">
          <span class="label !text-inherit">Orchestrators</span>
          <StatusChip v-if="h" data-testid="orchestrator-state" :tone="h.tone" :label="h.label" />
          <span v-else class="skeleton h-6 w-20" />
        </div>
        <p class="mt-2 text-[15px]" :class="h?.message ? 'text-fg' : 'text-soft'">{{ verdict }}</p>
        <p v-if="bridge.healthError || !bridge.healthAt" class="mt-2 text-sm text-warn">Health unavailable. Showing the last read.</p>
        <p v-else class="mt-2 text-xs text-dim" :title="iso(bridge.healthAt)">
          Read {{ ago(bridge.healthAt / 1000, now) }} · 300 blocks scanned · {{ bridge.healthSampled ? 'unsigned sampled' : 'all unsigned read' }}
        </p>
      </div>
      <div class="kpis">
        <div>
          <div class="label">Last signature</div>
          <div class="kpi">{{ h?.lastAction ? ago(h.lastAction.at, now) : '–' }}</div>
        </div>
        <div>
          <div class="label">Waiting to sign</div>
          <div class="kpi">{{ h ? bridge.unsignedCount : '–' }}</div>
        </div>
        <div>
          <div class="label">Oldest wait</div>
          <div class="kpi">{{ h?.oldestWaitSeconds ? duration(h.oldestWaitSeconds) : '–' }}</div>
        </div>
        <div title="Seen producing bridge blocks. Not a measure of signing readiness.">
          <div class="label">Producers, 24h</div>
          <div class="kpi">{{ h ? activeCount : '–' }}</div>
        </div>
      </div>

      <div v-if="h?.waiting.length" class="border-t border-line px-4 py-3 md:px-5">
        <div class="label mb-2">Waiting for a signature</div>
        <div class="grid gap-1">
          <div v-for="w in h.waiting" :key="w.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <Amount :value="BigInt(w.amount)" :decimals="w.decimals" :symbol="w.symbol" />
            <span class="text-dim">to {{ evmChain(w.chainId).name }}</span>
            <Address :value="w.id" :href="config.zenonExplorerTx(w.id)" :copy="false" class="text-dim" />
            <span class="mono ml-auto text-warn">{{ duration(w.ageSeconds) }}</span>
          </div>
        </div>
      </div>

      <div class="border-t border-line">
        <div class="flex items-center justify-between px-4 pt-3 md:px-5">
          <span class="label">Seen signing</span>
          <span v-if="h?.scannedSince" class="text-xs text-dim" :title="iso(h.scannedSince * 1000)">since {{ ago(h.scannedSince, now) }}</span>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>Pillar</th><th>Producer</th><th class="num">Signed</th><th class="num">Unwraps</th><th class="num">Last seen</th></tr>
            </thead>
            <tbody>
              <tr v-for="o in h?.orchestrators ?? []" :key="o.producer">
                <td class="lead">
                  <span class="inline-flex items-center gap-2">
                    <span class="state-dot" :class="now - o.lastSeen <= ACTIVE_WITHIN_S ? 'on' : 'off'" />
                    {{ o.name ?? 'Unknown' }}
                  </span>
                </td>
                <td data-label="Producer"><Address :value="o.producer" :href="config.zenonExplorerAddress(o.producer)" :copy="false" /></td>
                <td data-label="Signed" class="num mono">{{ o.signs }}</td>
                <td data-label="Unwraps" class="num mono">{{ o.unwraps }}</td>
                <td data-label="Last seen" class="num text-soft">{{ ago(o.lastSeen, now) }}</td>
              </tr>
              <tr v-if="h && !h.orchestrators.length"><td colspan="5" class="lead text-soft">None yet</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <p v-if="extrasError" class="text-sm text-warn">{{ extrasError }}</p>

    <!-- Network -->
    <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <div class="panel p-4">
        <div class="label">Momentum</div>
        <div class="kpi mono">{{ node.height ? node.height.toLocaleString('en-US') : '–' }}</div>
        <div class="text-sm text-dim">{{ node.rate.toFixed(1) }}s, target {{ momentumTime }}s</div>
      </div>
      <div class="panel p-4" :title="extrasReadAt ? 'Read ' + iso(extrasReadAt) : undefined">
        <div class="label">Wraps</div>
        <div class="kpi mono">{{ totals?.wraps.toLocaleString('en-US') ?? '–' }}</div>
        <div class="text-sm text-dim">Zenon to EVM</div>
      </div>
      <div class="panel p-4" :title="extrasReadAt ? 'Read ' + iso(extrasReadAt) : undefined">
        <div class="label">Unwraps</div>
        <div class="kpi mono">{{ totals?.unwraps.toLocaleString('en-US') ?? '–' }}</div>
        <div class="text-sm text-dim">EVM to Zenon</div>
      </div>
      <div class="panel p-4">
        <div class="label">Bridge</div>
        <div class="kpi">
          <StatusChip v-if="bridge.info" v-bind="halted(bridge.info.halted)" />
          <span v-else>–</span>
        </div>
        <div class="text-sm text-dim">Key nonce {{ bridge.info?.tssNonce ?? '–' }}{{ bridge.info?.allowKeyGen ? ' · new key open' : '' }}</div>
      </div>
    </div>

    <!-- Networks and pairs -->
    <div v-for="n in bridge.networks" :key="n.chainId" class="panel overflow-hidden">
      <div class="flex flex-wrap items-center gap-3 px-4 pt-4 md:px-5">
        <TokenIcon :network="n.name" :size="24" />
        <h2 class="text-lg font-semibold">{{ n.name }}</h2>
        <span class="mono text-sm text-dim">chain {{ n.chainId }}</span>
        <StatusChip v-if="bridge.evmNetworks[n.chainId]" v-bind="halted(bridge.evmNetworks[n.chainId].halted)" />
        <a
          v-if="evmAddressUrl(n.chainId, n.contractAddress)"
          :href="evmAddressUrl(n.chainId, n.contractAddress)"
          target="_blank"
          rel="noopener"
          class="ml-auto inline-flex items-center gap-1 text-sm text-dim hover:text-fg"
          ><span class="mono">{{ n.contractAddress.slice(0, 8) }}…{{ n.contractAddress.slice(-4) }}</span><ExternalLink :size="12"
        /></a>
      </div>
      <div class="px-4 pt-1 text-sm text-dim md:px-5">
        {{ bridge.evmNetworks[n.chainId]?.confirmations ?? '–' }} confirmations · {{ bridge.evmNetworks[n.chainId]?.blockTime ?? '–' }}s blocks
      </div>
      <div class="table-wrap mt-2">
        <table class="data">
          <thead>
            <tr>
              <th>Zenon</th>
              <th>{{ n.name }}</th>
              <th class="num">Fee</th>
              <th class="num">Min</th>
              <th class="num" title="Redeem delay: on Zenon · on the EVM side">Delay</th>
              <th>Open</th>
              <th class="num">Fees held</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in bridge.routes.filter((x) => x.chainId === n.chainId)" :key="r.key">
              <td class="lead">
                <span class="inline-flex items-center gap-2"><TokenIcon :symbol="r.zts?.symbol" chain="Zenon" :size="24" />{{ r.zts?.symbol ?? '?' }}</span>
                <span class="pair-arrow text-dim">⇄</span>
                <a
                  class="pair-evm inline-flex items-center gap-2 hover:text-fg"
                  :href="evmAddressUrl(n.chainId, r.pair.tokenAddress) || undefined"
                  target="_blank"
                  rel="noopener"
                  :title="r.pair.tokenAddress"
                  ><TokenIcon :symbol="r.evm?.symbol" :chain="n.name" :size="24" />{{ r.evm?.symbol ?? '?' }}</a
                >
              </td>
              <td class="evm-col">
                <a
                  class="inline-flex items-center gap-2 hover:text-fg"
                  :href="evmAddressUrl(n.chainId, r.pair.tokenAddress) || undefined"
                  target="_blank"
                  rel="noopener"
                  :title="r.pair.tokenAddress"
                  ><TokenIcon :symbol="r.evm?.symbol" :chain="n.name" :size="24" />{{ r.evm?.symbol ?? '?' }}</a
                >
              </td>
              <td data-label="Fee" class="num mono">{{ r.pair.feePercentage / 100 }}%</td>
              <td data-label="Min" class="num"><Amount :value="r.pair.minAmount" :decimals="r.zts?.decimals ?? 8" /></td>
              <td data-label="Delay" class="num mono text-soft" :title="delays(r.pair.redeemDelay, r.evmInfo?.redeemDelay, bridge.evmNetworks[n.chainId]?.blockTime).title">
                {{ delays(r.pair.redeemDelay, r.evmInfo?.redeemDelay, bridge.evmNetworks[n.chainId]?.blockTime).text }}
              </td>
              <td data-label="Open">
                <span class="inline-flex gap-1">
                  <span class="chip" :class="r.canWrap ? 'chip-ok' : 'chip-dim'" :title="'Zenon to ' + n.name + (r.canWrap ? ': open' : ': closed')">
                    <ArrowUpRight :size="12" />Out<Check v-if="r.canWrap" :size="12" /><Minus v-else :size="12" />
                  </span>
                  <span class="chip" :class="r.canUnwrap ? 'chip-ok' : 'chip-dim'" :title="n.name + ' to Zenon' + (r.canUnwrap ? ': open' : ': closed')">
                    <ArrowDownLeft :size="12" />In<Check v-if="r.canUnwrap" :size="12" /><Minus v-else :size="12" />
                  </span>
                </span>
              </td>
              <td data-label="Fees held" class="num">
                <Amount
                  v-if="fees[r.pair.tokenStandard] !== undefined && r.pair.feePercentage"
                  :value="fees[r.pair.tokenStandard]"
                  :decimals="zenonTokens.get(r.pair.tokenStandard)?.decimals ?? 8"
                  :max="2"
                />
                <span v-else class="text-dim">–</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- The contract's settings: read rarely, so folded. -->
    <div class="grid items-start gap-3 md:grid-cols-2">
      <details class="panel fold">
        <summary><h2 class="text-lg font-semibold">Configuration</h2><ChevronDown :size="16" class="chev" /></summary>
        <dl class="kv">
          <div><dt>Finality</dt><dd class="mono">{{ bridge.orch?.confirmationsToFinality ?? '–' }} momentums</dd></div>
          <div><dt>Signing pool</dt><dd class="mono">{{ bridge.orch?.windowSize ?? '–' }}</dd></div>
          <div><dt>Key threshold</dt><dd class="mono">{{ bridge.orch?.keyGenThreshold ?? '–' }}</dd></div>
          <div><dt>Guardians</dt><dd class="mono">{{ security?.guardians.length ?? '–' }}</dd></div>
          <div>
            <dt>Admin delay</dt>
            <dd class="mono" :title="security ? security.administratorDelay + ' momentums' : undefined">{{ security ? duration(security.administratorDelay * momentumTime) : '–' }}</dd>
          </div>
          <div>
            <dt>Soft delay</dt>
            <dd class="mono" :title="security ? security.softDelay + ' momentums' : undefined">{{ security ? duration(security.softDelay * momentumTime) : '–' }}</dd>
          </div>
          <div>
            <dt>Administrator</dt>
            <dd><Address v-if="bridge.info" :value="bridge.info.administrator" :href="config.zenonExplorerAddress(bridge.info.administrator)" /></dd>
          </div>
          <div>
            <dt>Referral</dt>
            <dd>
              <span v-if="!affiliate.length" class="text-dim">Off</span>
              <span v-for="[id, a] in affiliate" :key="id" class="block text-right">
                {{ evmChain(Number(id)).name }} from {{ a.startingHeight }}: {{ ['wZNN', 'wQSR'].filter((s) => a[s] === true).join(', ') || 'none' }}
              </span>
            </dd>
          </div>
        </dl>
      </details>
      <details class="panel fold">
        <summary>
          <h2 class="text-lg font-semibold">Liquidity program</h2>
          <StatusChip
            v-if="liquidity"
            :tone="liquidity.isHalted ? 'danger' : liquidity.znnReward || liquidity.qsrReward ? 'ok' : 'dim'"
            :label="liquidity.isHalted ? 'Halted' : liquidity.znnReward || liquidity.qsrReward ? 'Paying' : 'No rewards'"
          />
          <ChevronDown :size="16" class="chev" />
        </summary>
        <dl v-if="liquidity" class="kv">
          <div><dt>ZNN per epoch</dt><dd><Amount :value="liquidity.znnReward" :decimals="8" /></dd></div>
          <div><dt>QSR per epoch</dt><dd><Amount :value="liquidity.qsrReward" :decimals="8" /></dd></div>
          <div v-for="t in liquidity.tokenTuples" :key="t.tokenStandard">
            <dt>{{ zenonTokens.get(t.tokenStandard)?.symbol ?? t.tokenStandard.slice(0, 10) + '…' }}</dt>
            <dd class="mono">{{ t.znnPercentage / 100 }}% ZNN · {{ t.qsrPercentage / 100 }}% QSR</dd>
          </div>
        </dl>
        <div v-else class="skeleton h-32" />
      </details>
    </div>

    <p class="text-sm text-dim">Read from <span class="mono">{{ hostOf(node.url) }}</span> and each bridge contract.</p>
  </section>
</template>

<style scoped>
.status-head {
  padding: 16px 20px;
  border-bottom: 1px solid var(--line);
}
.tone-danger {
  background: var(--danger-bg);
  color: var(--danger);
}
.tone-warn {
  background: var(--warn-bg);
  color: var(--warn);
}
.tone-ok {
  background: var(--ok-bg);
  color: var(--ok);
}
.tone-dim,
.tone-wait {
  color: var(--dim);
}
.kpis {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  padding: 16px 20px;
}
@media (min-width: 700px) {
  .kpis {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
.kpi {
  margin-top: 4px;
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.table-wrap {
  overflow-x: auto;
}
.data {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.data th {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--dim);
  text-align: left;
  padding: 10px 16px;
  white-space: nowrap;
}
.data td {
  padding: 10px 16px;
  border-top: 1px solid var(--line);
  white-space: nowrap;
}
.data .num {
  text-align: right;
}
.data .chip {
  gap: 3px;
}
.data tbody tr {
  transition: background 150ms var(--ease);
}
.data tbody tr:hover {
  background: var(--raised);
}
/* On a wide table the EVM token has its own column; on a phone it rides
   beside the Zenon token as a pair. */
.pair-arrow,
.pair-evm {
  display: none;
}
/* A phone gets each row as a card: the same cells, labelled, two to a line,
   so nothing scrolls sideways and nothing is dropped. */
@media (max-width: 639px) {
  .data thead {
    display: none;
  }
  .data,
  .data tbody {
    display: block;
  }
  .data tr {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 16px;
    padding: 12px 16px;
    border-top: 1px solid var(--line);
  }
  .data td {
    min-width: 0;
    padding: 0;
    border: 0;
    white-space: normal;
  }
  .data .num {
    text-align: left;
  }
  .data td[data-label]::before {
    content: attr(data-label);
    display: block;
    margin-bottom: 2px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .data td.lead {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .data .evm-col {
    display: none;
  }
  .pair-arrow,
  .pair-evm {
    display: inline-flex;
  }
}
.state-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.state-dot.on {
  background: var(--ok);
  color: var(--ok);
  animation: pulse-ring 2s var(--ease) infinite;
}
.state-dot.off {
  background: var(--line-strong);
}
.fold {
  padding: 16px 20px;
}
.fold summary {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 32px;
  list-style: none;
  cursor: pointer;
}
.fold summary::-webkit-details-marker {
  display: none;
}
.fold summary h2 {
  flex: 1;
}
.fold .chev {
  color: var(--dim);
  transition: transform 260ms var(--spring);
}
.fold[open] .chev {
  transform: rotate(180deg);
}
.fold[open] summary {
  margin-bottom: 12px;
}
.kv {
  display: grid;
  gap: 8px;
  font-size: 14px;
}
.kv > div {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}
.kv dt {
  color: var(--dim);
  white-space: nowrap;
}
.kv dd {
  text-align: right;
  min-width: 0;
}
</style>
