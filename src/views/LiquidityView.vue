<script setup lang="ts">
// The liquidity program, in its three steps:
//   1. add wZNN and ETH to the Uniswap V2 pool on Ethereum, for LP tokens;
//   2. bridge the LP token to Zenon (an unwrap, on the Bridge view);
//   3. stake it in Zenon's liquidity contract for 1 to 12 months, weighted 1x
//      to 12x, then revoke after expiry and collect rewards.
import { computed, onMounted, ref, watch } from 'vue'
import { Plus, ArrowRight, Loader2, Lock, Unlock, Coins } from 'lucide-vue-next'
import TokenIcon from '../components/TokenIcon.vue'
import Amount from '../components/Amount.vue'
import StatusChip from '../components/StatusChip.vue'
import Terms from '../components/Terms.vue'
import { bridge, routeByZts } from '../state/bridge.ts'
import { api, node, syrius, sendBlock, connectSyrius, onBuildChain } from '../state/zenon.ts'
import { evm, ensureChain, walletForReads } from '../state/evm.ts'
import { go, bridgePrefill } from '../state/router.ts'
import { accepted } from '../state/ack.ts'
import { toast, toastError } from '../state/toasts.ts'
import { readClient, writeClient } from '../evm/client.ts'
import { erc20Abi, pairAbi, routerAbi } from '../evm/abi.ts'
import {
  liquidityStakeBlock,
  cancelLiquidityStakeBlock,
  collectRewardBlock,
  MONTH_SECONDS,
  type LiquidityInfo,
  type StakeEntry,
} from '../znn/api.ts'
import { parseUnits, formatUnits, unitsToInput, duration } from '../core/format.ts'
import { config, evmChain, evmTxUrl } from '../config.ts'

const termsOpen = ref(false)
const pendingAction = ref<null | (() => Promise<void>)>(null)
function guarded(fn: () => Promise<void>) {
  if (!accepted.value) {
    pendingAction.value = fn
    termsOpen.value = true
    return
  }
  void fn()
}

// 1. Uniswap V2

// The pool is a mainnet fact; another chain's bridge has none configured here.
const poolChainId = computed(() => (onBuildChain() ? Number(Object.entries(config.evm).find(([, c]) => c.liquidity)?.[0] ?? 0) : 0))
const pool = computed(() => (poolChainId.value ? config.evm[poolChainId.value].liquidity! : null))
const wznn = computed(() => (poolChainId.value ? routeByZts(poolChainId.value, 'zts1znnxxxxxxxxxxxxx9z4ulx') : undefined))
const reserves = ref<{ znn: bigint; eth: bigint; lpSupply: bigint } | null>(null)
const balances = ref<{ znn: bigint; eth: bigint; lp: bigint; allowance: bigint } | null>(null)
const znnText = ref('')
const slippage = ref(1)
const adding = ref(false)

async function loadPool() {
  const p = pool.value
  const token = wznn.value?.pair.tokenAddress as `0x${string}` | undefined
  if (!p || !token) return
  const c = readClient(poolChainId.value, walletForReads())
  try {
    const [r, t0, supply] = await Promise.all([
      c.readContract({ address: p.pair, abi: pairAbi, functionName: 'getReserves' }),
      c.readContract({ address: p.pair, abi: pairAbi, functionName: 'token0' }),
      c.readContract({ address: p.pair, abi: pairAbi, functionName: 'totalSupply' }),
    ])
    const znnFirst = t0.toLowerCase() === token.toLowerCase()
    reserves.value = { znn: znnFirst ? r[0] : r[1], eth: znnFirst ? r[1] : r[0], lpSupply: supply }
    if (evm.account) {
      const [z, e, lp, a] = await Promise.all([
        c.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [evm.account] }),
        c.getBalance({ address: evm.account }),
        c.readContract({ address: p.pair, abi: pairAbi, functionName: 'balanceOf', args: [evm.account] }),
        c.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [evm.account, p.router] }),
      ])
      balances.value = { znn: z, eth: e, lp, allowance: a }
    } else balances.value = null
  } catch {
    /* keep the last values */
  }
}

const znnAmount = computed(() => parseUnits(znnText.value, wznn.value?.evm?.decimals ?? 8))
const ethAmount = computed(() => {
  const r = reserves.value
  if (!r || !znnAmount.value || !r.znn) return 0n
  return (znnAmount.value * r.eth) / r.znn
})
const lpOut = computed(() => {
  const r = reserves.value
  if (!r || !znnAmount.value || !r.znn) return 0n
  return (znnAmount.value * r.lpSupply) / r.znn
})
const needsApprove = computed(() => !!balances.value && !!znnAmount.value && balances.value.allowance < znnAmount.value)
const addBlocker = computed(() => {
  if (!evm.account) return 'Connect EVM wallet'
  if (evm.chainId !== poolChainId.value) return `Switch to ${evmChain(poolChainId.value).name}`
  if (!znnAmount.value) return 'Enter an amount'
  if (balances.value && znnAmount.value > balances.value.znn) return 'Not enough wZNN'
  if (balances.value && ethAmount.value > balances.value.eth) return 'Not enough ETH'
  return ''
})

async function addLiquidity() {
  const b = addBlocker.value
  if (b === 'Connect EVM wallet') return void (evm.pickerOpen = true)
  if (b.startsWith('Switch')) return void ensureChain(poolChainId.value).catch(toastError)
  if (b) return
  const p = pool.value!
  const token = wznn.value!.pair.tokenAddress as `0x${string}`
  adding.value = true
  try {
    const w = writeClient(poolChainId.value, evm.selected!.provider, evm.account!)
    const reader = readClient(poolChainId.value, walletForReads())
    if (needsApprove.value) {
      const h = await w.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [p.router, znnAmount.value!], chain: w.chain, account: evm.account! })
      toast('Approval sent', 'wait')
      await reader.waitForTransactionReceipt({ hash: h })
    }
    // Deadline: latest block time + 90 s, as the original.
    const block = await reader.getBlock()
    const keep = BigInt(Math.round((100 - slippage.value) * 100))
    const hash = await w.writeContract({
      address: p.router,
      abi: routerAbi,
      functionName: 'addLiquidityETH',
      args: [token, znnAmount.value!, (znnAmount.value! * keep) / 10000n, (ethAmount.value * keep) / 10000n, evm.account!, block.timestamp + 90n],
      value: ethAmount.value,
      chain: w.chain,
      account: evm.account!,
    })
    const url = evmTxUrl(poolChainId.value, hash)
    toast('Liquidity sent', 'wait', url ? { href: url, label: 'View' } : undefined)
    await reader.waitForTransactionReceipt({ hash })
    toast('LP tokens received. Bridge them to Zenon next.', 'ok')
    znnText.value = ''
    await loadPool()
  } catch (err) {
    toastError(err)
  } finally {
    adding.value = false
  }
}

function bridgeLp() {
  const lp = bridge.routes.find((r) => r.chainId === poolChainId.value && pool.value && r.pair.tokenAddress.toLowerCase() === pool.value.pair.toLowerCase())
  if (lp) bridgePrefill.value = { dir: 'unwrap', chainId: lp.chainId, zts: lp.pair.tokenStandard }
  go('bridge')
}

// 2 and 3. Zenon liquidity contract

const info = ref<LiquidityInfo | null>(null)
const stakes = ref<StakeEntry[]>([])
const reward = ref<{ znn: bigint; qsr: bigint } | null>(null)
const lpBalances = ref<Record<string, bigint>>({})
const stakeZts = ref('')
const stakeText = ref('')
const months = ref(12)
const busy = ref<Record<string, boolean>>({})

async function loadZenon() {
  try {
    info.value = await api.value.liquidityInfo()
    if (!stakeZts.value) stakeZts.value = info.value.tokenTuples[0]?.tokenStandard ?? ''
    if (syrius.address) {
      const [s, r, b] = await Promise.all([api.value.stakeEntries(syrius.address), api.value.uncollectedReward(syrius.address), api.value.balances(syrius.address)])
      stakes.value = s.list
      reward.value = r
      lpBalances.value = b
    } else {
      stakes.value = []
      reward.value = null
    }
  } catch {
    /* keep */
  }
}

const tuple = computed(() => info.value?.tokenTuples.find((t) => t.tokenStandard === stakeZts.value))
const lpToken = (zts: string) => bridge.routes.find((r) => r.pair.tokenStandard === zts)?.zts
const stakeDecimals = computed(() => lpToken(stakeZts.value)?.decimals ?? 18)
const stakeAmount = computed(() => parseUnits(stakeText.value, stakeDecimals.value))
const stakeBalance = computed(() => lpBalances.value[stakeZts.value] ?? 0n)
const stakeBlocker = computed(() => {
  if (!syrius.address) return 'Connect Syrius'
  if (info.value?.isHalted) return 'Program halted'
  if (!stakeAmount.value) return 'Enter an amount'
  if (tuple.value && stakeAmount.value < tuple.value.minAmount) return 'Below minimum'
  if (stakeAmount.value > stakeBalance.value) return 'Not enough LP'
  return ''
})

async function stake() {
  if (stakeBlocker.value === 'Connect Syrius') return void connectSyrius().catch(toastError)
  if (stakeBlocker.value) return
  busy.value.stake = true
  try {
    const hash = await sendBlock(liquidityStakeBlock(months.value, stakeZts.value, stakeAmount.value!))
    toast('Stake sent', 'ok', { href: config.zenonExplorerTx(hash), label: 'View' })
    stakeText.value = ''
    setTimeout(loadZenon, 25_000)
  } catch (err) {
    toastError(err)
  } finally {
    busy.value.stake = false
  }
}

async function cancel(e: StakeEntry) {
  busy.value[e.id] = true
  try {
    const hash = await sendBlock(cancelLiquidityStakeBlock(e.id))
    toast('Revoke sent', 'ok', { href: config.zenonExplorerTx(hash), label: 'View' })
    setTimeout(loadZenon, 25_000)
  } catch (err) {
    toastError(err)
  } finally {
    busy.value[e.id] = false
  }
}

async function collect() {
  busy.value.collect = true
  try {
    const hash = await sendBlock(collectRewardBlock())
    toast('Collect sent', 'ok', { href: config.zenonExplorerTx(hash), label: 'View' })
    setTimeout(loadZenon, 25_000)
  } catch (err) {
    toastError(err)
  } finally {
    busy.value.collect = false
  }
}

const nowS = computed(() => node.timestamp || Math.floor(Date.now() / 1000))
function stakeStatus(e: StakeEntry) {
  if (e.revokeTime) return { tone: 'dim' as const, label: 'Revoked' }
  if (nowS.value < e.expirationTime) return { tone: 'wait' as const, label: `Locked ${duration(e.expirationTime - nowS.value)}` }
  return { tone: 'warn' as const, label: 'Unlocked' }
}

onMounted(() => {
  void loadPool()
  void loadZenon()
})
watch([() => evm.account, () => evm.chainId, () => bridge.loaded], loadPool)
watch(() => syrius.address, loadZenon)
watch(
  () => node.tick,
  (t) => t % 6 === 0 && (loadPool(), loadZenon()),
)
</script>

<template>
  <section class="rise grid grid-cols-1 gap-5">
    <div>
      <h1 class="text-2xl font-semibold">Liquidity</h1>
      <p class="mt-1 text-soft">Add to the wZNN pool, bridge the LP token to Zenon, stake it for rewards.</p>
    </div>

    <div class="grid gap-4 md:grid-cols-3">
      <!-- Step 1 -->
      <div v-if="pool" class="panel grid min-w-0 grid-cols-1 content-start gap-3 p-4 md:p-5">
        <div class="flex items-center gap-2"><span class="step">1</span><h2 class="font-semibold">Add liquidity</h2></div>
        <div class="text-sm text-dim">Uniswap V2 · {{ evmChain(poolChainId).name }}</div>
        <div class="well grid grid-cols-1 gap-2 p-3">
          <div class="flex items-center gap-2">
            <input v-model="znnText" class="amount mono w-0 min-w-0 flex-1" inputmode="decimal" placeholder="0" aria-label="wZNN amount" />
            <span class="inline-flex items-center gap-1.5"><TokenIcon symbol="wZNN" :size="20" />wZNN</span>
          </div>
          <div class="text-xs text-dim">
            Balance <Amount :value="balances?.znn ?? 0n" :decimals="8" />
            <button class="ml-1 text-ok" @click="znnText = unitsToInput(balances?.znn ?? 0n, 8)">Max</button>
          </div>
        </div>
        <div class="flex items-center justify-between text-sm">
          <span class="text-dim">With</span>
          <span class="inline-flex items-center gap-1.5"><Amount :value="ethAmount" :decimals="18" symbol="ETH" /></span>
        </div>
        <div class="flex items-center justify-between text-sm">
          <span class="text-dim">LP out</span>
          <Amount :value="lpOut" :decimals="18" :max="10" />
        </div>
        <div class="flex items-center justify-between gap-2 text-sm">
          <span class="text-dim">Slippage</span>
          <span class="inline-flex gap-1">
            <button v-for="s in [0.5, 1, 3]" :key="s" class="chip !h-8 !px-3" :class="slippage === s ? 'chip-ok' : 'chip-dim'" @click="slippage = s">{{ s }}%</button>
          </span>
        </div>
        <button class="btn btn-block" :disabled="adding || (!!addBlocker && !addBlocker.startsWith('Switch') && addBlocker !== 'Connect EVM wallet')" @click="guarded(addLiquidity)">
          <Loader2 v-if="adding" :size="15" class="spin" /><Plus v-else :size="15" />
          {{ addBlocker || (needsApprove ? 'Approve and add' : 'Add liquidity') }}
        </button>
        <div v-if="balances?.lp" class="flex items-center justify-between text-sm">
          <span class="text-dim">You hold</span><Amount :value="balances.lp" :decimals="18" :max="10" symbol="LP" />
        </div>
        <a :href="pool.info" target="_blank" rel="noopener" class="text-sm text-dim hover:text-fg">Pool on Uniswap</a>
      </div>

      <!-- Step 2 -->
      <div class="panel grid min-w-0 grid-cols-1 content-start gap-3 p-4 md:p-5">
        <div class="flex items-center gap-2"><span class="step">2</span><h2 class="font-semibold">Bridge LP</h2></div>
        <p class="text-sm text-soft">Unwrap the LP token to Zenon, then redeem it from Activity.</p>
        <button class="btn btn-block" @click="bridgeLp">Open bridge<ArrowRight :size="15" /></button>
      </div>

      <!-- Step 3 -->
      <div class="panel grid min-w-0 grid-cols-1 content-start gap-3 p-4 md:p-5">
        <div class="flex items-center gap-2"><span class="step">3</span><h2 class="font-semibold">Stake on Zenon</h2></div>
        <div v-if="info && info.tokenTuples.length > 1" class="flex flex-wrap gap-1">
          <button v-for="t in info.tokenTuples" :key="t.tokenStandard" class="chip !h-8 !px-3" :class="stakeZts === t.tokenStandard ? 'chip-ok' : 'chip-dim'" @click="stakeZts = t.tokenStandard">
            {{ lpToken(t.tokenStandard)?.symbol ?? t.tokenStandard.slice(0, 8) }}
          </button>
        </div>
        <div class="well grid grid-cols-1 gap-2 p-3">
          <div class="flex items-center gap-2">
            <input v-model="stakeText" class="amount mono w-0 min-w-0 flex-1" inputmode="decimal" placeholder="0" aria-label="LP amount" />
            <span class="text-sm">{{ lpToken(stakeZts)?.symbol ?? 'LP' }}</span>
          </div>
          <div class="text-xs text-dim">
            Balance <Amount :value="stakeBalance" :decimals="stakeDecimals" :max="10" />
            <button class="ml-1 text-ok" @click="stakeText = unitsToInput(stakeBalance, stakeDecimals)">Max</button>
          </div>
        </div>
        <div>
          <div class="mb-1 flex justify-between text-sm"><span class="text-dim">Lock</span><span class="mono">{{ months }} mo · {{ months }}x</span></div>
          <input v-model.number="months" type="range" min="1" max="12" step="1" class="w-full accent-[var(--znn)]" aria-label="Months" />
        </div>
        <button class="btn btn-plasma btn-block" :disabled="busy.stake || (!!stakeBlocker && stakeBlocker !== 'Connect Syrius')" @click="guarded(stake)">
          <Loader2 v-if="busy.stake" :size="15" class="spin" /><Lock v-else :size="15" />
          {{ stakeBlocker || 'Stake' }}
        </button>
        <div v-if="info" class="text-xs text-dim">
          Rewards per epoch: <Amount :value="info.znnReward" :decimals="8" symbol="ZNN" />, <Amount :value="info.qsrReward" :decimals="8" symbol="QSR" />
        </div>
      </div>
    </div>

    <div class="panel p-4 md:p-5">
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <h2 class="font-semibold">Your stakes</h2>
        <div class="flex-1" />
        <span v-if="reward" class="text-sm text-soft">
          Uncollected <Amount :value="reward.znn" :decimals="8" symbol="ZNN" /> · <Amount :value="reward.qsr" :decimals="8" symbol="QSR" />
        </span>
        <button class="btn btn-sm" :disabled="!reward || (!reward.znn && !reward.qsr) || busy.collect" @click="collect">
          <Loader2 v-if="busy.collect" :size="14" class="spin" /><Coins v-else :size="14" />Collect
        </button>
      </div>
      <p v-if="!syrius.address" class="text-soft">Connect Syrius to see your stakes.</p>
      <p v-else-if="!stakes.length" class="text-soft">None yet</p>
      <div v-else class="grid gap-2">
        <div v-for="e in stakes" :key="e.id" class="flex flex-wrap items-center gap-3 border-t border-line pt-2 text-sm first:border-0 first:pt-0">
          <Amount :value="e.amount" :decimals="lpToken(e.tokenStandard)?.decimals ?? 18" :max="10" :symbol="lpToken(e.tokenStandard)?.symbol" />
          <span class="text-dim">{{ Math.round((e.expirationTime - e.startTime) / MONTH_SECONDS) }} mo · weight {{ formatUnits(e.weightedAmount * 100n / (e.amount || 1n), 2) }}x</span>
          <div class="flex-1" />
          <StatusChip v-bind="stakeStatus(e)" />
          <button v-if="stakeStatus(e).label === 'Unlocked'" class="btn btn-sm" :disabled="busy[e.id]" @click="cancel(e)">
            <Loader2 v-if="busy[e.id]" :size="14" class="spin" /><Unlock v-else :size="14" />Revoke
          </button>
        </div>
      </div>
    </div>

    <Terms :open="termsOpen" @close="termsOpen = false" @accepted="((termsOpen = false), pendingAction && pendingAction())" />
  </section>
</template>

<style scoped>
.step {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 999px;
  background: var(--raised);
  border: 1px solid var(--line-strong);
  font-family: var(--font-mono);
  font-size: 12px;
}
.amount {
  background: transparent;
  border: 0;
  outline: none;
  font-size: 22px;
  color: var(--fg);
}
.amount::placeholder {
  color: var(--dim);
}
</style>
