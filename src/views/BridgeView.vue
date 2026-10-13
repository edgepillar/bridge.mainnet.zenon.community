<script setup lang="ts">
// Move a token between Zenon and an EVM network.
//
// Wrap (Zenon to EVM) is one Syrius send to the bridge contract; the EVM
// redeem happens later, from Activity. Unwrap (EVM to Zenon) is an ERC-20
// approve, if the allowance is short, then `unwrap` on the EVM bridge; the
// Zenon redeem happens later, from Activity.
import { computed, ref, watch } from 'vue'
import { ArrowDownUp, ChevronDown, Clock, Fuel, Gift, Plus, Loader2, SlidersHorizontal, Zap } from 'lucide-vue-next'
import TokenIcon from '../components/TokenIcon.vue'
import Amount from '../components/Amount.vue'
import Modal from '../components/Modal.vue'
import Terms from '../components/Terms.vue'
import { bridge, bridgeDown, type Route } from '../state/bridge.ts'
import { api, node, syrius, sendBlock, connectSyrius, wrongZenonChain, onBuildChain } from '../state/zenon.ts'
import { evm, ensureChain, walletForReads } from '../state/evm.ts'
import { referrer } from '../state/referral.ts'
import { remember } from '../state/activity.ts'
import { accepted } from '../state/ack.ts'
import { go, bridgePrefill } from '../state/router.ts'
import { toast, toastError } from '../state/toasts.ts'
import { readClient, writeClient } from '../evm/client.ts'
import { bridgeAbi, erc20Abi } from '../evm/abi.ts'
import { wrapTokenBlock, affiliateActive } from '../znn/api.ts'
import { isAddress } from '../znn/primitives.ts'
import { parseUnits, unitsToInput, duration, formatUnits, shorten } from '../core/format.ts'
import { wrapFee, wrapReceive, unwrapReceive, wrapEstimate, unwrapEstimate, LOW_PLASMA } from '../core/fees.ts'
import { recipientString } from '../core/referral.ts'
import { requestPlasma, canRequest } from '../core/plasmaBot.ts'
import { watchAsset } from '../wallet/eip6963.ts'
import { config, evmChain, evmTxUrl } from '../config.ts'

type Dir = 'wrap' | 'unwrap'
const dir = ref<Dir>('wrap')
const chainId = ref<number | null>(null)
const routeKey = ref<string>('')
const amountText = ref('')
const recipientText = ref('')
const editingRecipient = ref(false)
const picker = ref<'from' | 'to' | null>(null)
const pickerNet = ref<number | 'zenon'>('zenon')
const advanced = ref(false)
const details = ref(false)
const termsOpen = ref(false)
const sending = ref(false)
const approving = ref(false)
const sendWhileDown = ref(false)

// Opened from another view on a given route.
const prefill = bridgePrefill.value
bridgePrefill.value = null
if (prefill) {
  dir.value = prefill.dir
  chainId.value = prefill.chainId
}
watch(
  () => bridge.routes.length,
  () => {
    if (!prefill) return
    const r = bridge.routes.find((x) => x.chainId === prefill.chainId && x.pair.tokenStandard === prefill.zts)
    if (r) routeKey.value = r.key
  },
  { immediate: true },
)

const chains = computed(() => [...new Set(bridge.routes.map((r) => r.chainId))])
watch(
  chains,
  (list) => {
    if (!chainId.value || !list.includes(chainId.value)) chainId.value = list[0] ?? null
  },
  { immediate: true },
)

const routes = computed(() =>
  bridge.routes.filter((r) => r.chainId === chainId.value && (dir.value === 'wrap' ? r.canWrap : r.canUnwrap)),
)
watch(
  routes,
  (list) => {
    if (!list.some((r) => r.key === routeKey.value)) routeKey.value = list[0]?.key ?? ''
  },
  { immediate: true },
)
const route = computed<Route | undefined>(() => routes.value.find((r) => r.key === routeKey.value))

// Each side is picked on its own. An option is one asset on one chain; the
// route it stands for is what choosing it selects. The first route stays the
// default pair, so the form is never empty.
interface Option {
  id: string
  symbol: string
  network: string
  route: Route
  dir: Dir
  active: boolean
}
const zenonSources = computed<Option[]>(() => {
  const seen = new Set<string>()
  const out: Option[] = []
  for (const r of bridge.routes) {
    if (!r.canWrap || seen.has(r.pair.tokenStandard)) continue
    seen.add(r.pair.tokenStandard)
    // Stay on the chosen chain when it carries this token.
    const same = bridge.routes.find((x) => x.canWrap && x.pair.tokenStandard === r.pair.tokenStandard && x.chainId === chainId.value)
    out.push({
      id: r.pair.tokenStandard,
      symbol: r.zts?.symbol ?? '',
      network: 'Zenon',
      route: same ?? r,
      dir: 'wrap',
      active: dir.value === 'wrap' && route.value?.pair.tokenStandard === r.pair.tokenStandard,
    })
  }
  return out
})
const sourceNets = computed<(number | 'zenon')[]>(() => [
  ...(zenonSources.value.length ? (['zenon'] as const) : []),
  ...new Set(bridge.routes.filter((r) => r.canUnwrap).map((r) => r.chainId)),
])
const options = computed<Option[]>(() => {
  if (picker.value === 'from') {
    if (pickerNet.value === 'zenon') return zenonSources.value
    return bridge.routes
      .filter((r) => r.canUnwrap && r.chainId === pickerNet.value)
      .map((r) => ({ id: r.key, symbol: r.evm?.symbol ?? '', network: r.networkName, route: r, dir: 'unwrap' as Dir, active: dir.value === 'unwrap' && r.key === routeKey.value }))
  }
  const cur = route.value
  if (!cur) return []
  // Where the chosen source can go: one chain per route for a Zenon token, Zenon alone for an EVM one.
  if (dir.value === 'unwrap') return [{ id: cur.key, symbol: cur.zts?.symbol ?? '', network: 'Zenon', route: cur, dir: 'unwrap', active: true }]
  return bridge.routes
    .filter((r) => r.canWrap && r.pair.tokenStandard === cur.pair.tokenStandard)
    .map((r) => ({ id: r.key, symbol: r.evm?.symbol ?? '', network: r.networkName, route: r, dir: 'wrap' as Dir, active: r.key === routeKey.value }))
})
function openPicker(side: 'from' | 'to') {
  pickerNet.value = dir.value === 'wrap' ? 'zenon' : (chainId.value ?? 'zenon')
  picker.value = side
}
function pick(o: Option) {
  dir.value = o.dir
  chainId.value = o.route.chainId
  routeKey.value = o.route.key
  picker.value = null
}
const net = computed(() => (chainId.value ? evmChain(chainId.value) : null))
const evmNet = computed(() => (chainId.value ? bridge.evmNetworks[chainId.value] : undefined))

// What the user holds on the sending side, and the token's units there.
const srcSymbol = computed(() => (dir.value === 'wrap' ? route.value?.zts?.symbol : route.value?.evm?.symbol) ?? '')
const dstSymbol = computed(() => (dir.value === 'wrap' ? route.value?.evm?.symbol : route.value?.zts?.symbol) ?? '')
// Every asset is shown with the chain it is on.
const srcNet = computed(() => (dir.value === 'wrap' ? 'Zenon' : (net.value?.name ?? '')))
const dstNet = computed(() => (dir.value === 'wrap' ? (net.value?.name ?? '') : 'Zenon'))
const decimals = computed(() => (dir.value === 'wrap' ? route.value?.zts?.decimals : route.value?.evm?.decimals) ?? 8)

const balance = ref<bigint | null>(null)
const allowance = ref<bigint | null>(null)
const plasma = ref<number | null>(null)
const recipientPlasma = ref<number | null>(null)

async function refreshBalances() {
  const r = route.value
  if (!r) return
  try {
    if (dir.value === 'wrap') {
      allowance.value = null
      if (!syrius.address) return void (balance.value = null)
      const [b, p] = await Promise.all([api.value.balances(syrius.address), api.value.plasma(syrius.address)])
      balance.value = b[r.pair.tokenStandard] ?? 0n
      plasma.value = p.currentPlasma
    } else {
      if (!evm.account) return void ((balance.value = null), (allowance.value = null))
      const c = readClient(r.chainId, walletForReads())
      const token = r.pair.tokenAddress as `0x${string}`
      const [b, a] = await Promise.all([
        c.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [evm.account] }),
        c.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [evm.account, r.contract] }),
      ])
      balance.value = b
      allowance.value = a
    }
  } catch {
    /* keep the last value */
  }
}
watch([route, dir, () => syrius.address, () => evm.account, () => evm.chainId], refreshBalances, { immediate: true })
watch(
  () => node.tick,
  (t) => t % 3 === 0 && refreshBalances(),
)

// Recipient: the connected wallet on the receiving side, unless edited.
const defaultRecipient = computed(() => (dir.value === 'wrap' ? (evm.account ?? '') : (syrius.address ?? '')))
const recipient = computed(() => (editingRecipient.value ? recipientText.value.trim() : defaultRecipient.value))
const recipientValid = computed(() =>
  dir.value === 'wrap' ? /^0x[0-9a-fA-F]{40}$/.test(recipient.value) : isAddress(recipient.value),
)
// A wallet connected while the box is open and nothing valid is typed fills
// it: the box was opened only because there was no wallet to take it from.
watch(defaultRecipient, (now) => {
  if (now && editingRecipient.value && !recipientValid.value) {
    editingRecipient.value = false
    recipientText.value = ''
  }
})
function toggleCustomRecipient() {
  editingRecipient.value = !editingRecipient.value
  recipientText.value = editingRecipient.value ? defaultRecipient.value : ''
}
watch(dir, (_n, old) => {
  if (old === undefined) return
  editingRecipient.value = false
  recipientText.value = ''
  amountText.value = ''
})

async function checkRecipientPlasma() {
  recipientPlasma.value = null
  if (dir.value !== 'unwrap' || !recipientValid.value) return
  try {
    recipientPlasma.value = (await api.value.plasma(recipient.value)).currentPlasma
  } catch {
    /* unknown */
  }
}
watch([recipient, dir], checkRecipientPlasma, { immediate: true })

const amount = computed(() => parseUnits(amountText.value, decimals.value))
const min = computed(() => {
  const r = route.value
  if (!r) return 0n
  return dir.value === 'wrap' ? r.pair.minAmount : (r.evmInfo?.minAmount ?? 0n)
})
const fee = computed(() => (dir.value === 'wrap' && amount.value && route.value ? wrapFee(amount.value, route.value.pair.feePercentage) : 0n))
const bonus = computed(
  () => dir.value === 'unwrap' && !!referrer.value && !!route.value && affiliateActive(bridge.meta, route.value.chainId, route.value.pair.tokenStandard),
)
const receive = computed(() => {
  if (!amount.value || !route.value) return 0n
  return dir.value === 'wrap' ? wrapReceive(amount.value, route.value.pair.feePercentage) : unwrapReceive(amount.value, bonus.value)
})
const estimate = computed(() => {
  const r = route.value
  const o = bridge.orch
  if (!r || !o) return null
  const momentumSeconds = Math.max(node.rate, o.estimatedMomentumTime || 10)
  const e =
    dir.value === 'wrap'
      ? wrapEstimate({
          confirmationsToFinality: o.confirmationsToFinality,
          momentumSeconds,
          evmRedeemDelayBlocks: Number(r.evmInfo?.redeemDelay ?? 0n),
          evmBlockSeconds: evmNet.value?.blockTime ?? 12,
        })
      : unwrapEstimate({
          evmConfirmations: evmNet.value?.confirmations ?? 0,
          evmBlockSeconds: evmNet.value?.blockTime ?? 12,
          redeemDelayMomentums: r.pair.redeemDelay,
          momentumSeconds,
        })
  return e.seconds
})

function setMax() {
  if (balance.value !== null) amountText.value = unitsToInput(balance.value, decimals.value)
}

function flip() {
  dir.value = dir.value === 'wrap' ? 'unwrap' : 'wrap'
}

const needsApproval = computed(
  () => dir.value === 'unwrap' && amount.value !== null && allowance.value !== null && allowance.value < amount.value,
)

// The button says what is missing, in the order the user meets it.
const blocker = computed<string>(() => {
  if (!bridge.loaded) return 'Loading'
  if (!route.value) return 'No route'
  if (dir.value === 'wrap' && !syrius.address) return syrius.present ? 'Connect Syrius' : 'Install Syrius'
  if (dir.value === 'wrap' && wrongZenonChain()) return 'Syrius is on another chain'
  if (dir.value === 'unwrap' && !evm.account) return 'Connect EVM wallet'
  if (dir.value === 'unwrap' && evm.chainId !== chainId.value) return `Switch to ${net.value?.name}`
  if (!amountText.value) return 'Enter an amount'
  if (amount.value === null) return 'Invalid amount'
  if (amount.value === 0n) return 'Enter an amount'
  if (amount.value < min.value) return `Minimum ${formatUnits(min.value, decimals.value)} ${srcSymbol.value}`
  if (balance.value !== null && amount.value > balance.value) return `Not enough ${srcSymbol.value}`
  if (!recipient.value) return dir.value === 'wrap' ? 'Connect EVM wallet or enter recipient' : 'Connect Syrius or enter recipient'
  if (!recipientValid.value) return 'Invalid recipient'
  if (bridgeDown() && !sendWhileDown.value) return 'Bridge is down'
  return ''
})

const actionLabel = computed(() => {
  if (blocker.value) return blocker.value
  if (needsApproval.value) return `Approve ${srcSymbol.value}`
  return dir.value === 'wrap' ? `Bridge to ${net.value?.name}` : 'Bridge to Zenon'
})

const actionable = computed(() => {
  const b = blocker.value
  return !b || b === 'Connect Syrius' || b === 'Install Syrius' || b === 'Connect EVM wallet' || b.startsWith('Switch to')
})

async function onAction() {
  const b = blocker.value
  try {
    if (b === 'Connect Syrius') return await connectSyrius()
    if (b === 'Install Syrius') return void window.open('https://github.com/DexterLabZ/syrius-extension/releases', '_blank', 'noopener')
    if (b === 'Connect EVM wallet') return void (evm.pickerOpen = true)
    if (b.startsWith('Switch to') && chainId.value) return await ensureChain(chainId.value)
    if (b) return
    if (!accepted.value) return void (termsOpen.value = true)
    if (needsApproval.value) return await approve()
    if (dir.value === 'wrap') await sendWrap()
    else await sendUnwrap()
  } catch (err) {
    toastError(err)
  }
}

async function sendWrap() {
  const r = route.value!
  sending.value = true
  try {
    const hash = await sendBlock(
      wrapTokenBlock({ networkClass: r.networkClass, chainId: r.chainId, toAddress: recipient.value, tokenStandard: r.pair.tokenStandard, amount: amount.value! }),
    )
    remember({
      kind: 'wrap',
      id: hash,
      chainId: r.chainId,
      toAddress: recipient.value.toLowerCase(),
      from: syrius.address!,
      tokenStandard: r.pair.tokenStandard,
      amount: receive.value.toString(),
      createdAt: Math.floor(Date.now() / 1000),
    })
    toast(`Sent. Redeem on ${r.networkName} once signed.`, 'ok', { href: config.zenonExplorerTx(hash), label: 'View' })
    amountText.value = ''
    go('activity')
  } finally {
    sending.value = false
  }
}

async function approve() {
  const r = route.value!
  approving.value = true
  try {
    await ensureChain(r.chainId)
    const w = writeClient(r.chainId, evm.selected!.provider, evm.account!)
    const hash = await w.writeContract({
      address: r.pair.tokenAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: 'approve',
      args: [r.contract, amount.value!],
      chain: w.chain,
      account: evm.account!,
    })
    toast('Approval sent', 'wait', evmTxUrl(r.chainId, hash) ? { href: evmTxUrl(r.chainId, hash), label: 'View' } : undefined)
    await readClient(r.chainId, walletForReads()).waitForTransactionReceipt({ hash })
    await refreshBalances()
  } finally {
    approving.value = false
  }
}

async function sendUnwrap() {
  const r = route.value!
  sending.value = true
  try {
    await ensureChain(r.chainId)
    const w = writeClient(r.chainId, evm.selected!.provider, evm.account!)
    const to = recipientString(recipient.value, bonus.value ? referrer.value : null)
    const hash = await w.writeContract({
      address: r.contract,
      abi: bridgeAbi,
      functionName: 'unwrap',
      args: [r.pair.tokenAddress as `0x${string}`, amount.value!, to],
      chain: w.chain,
      account: evm.account!,
    })
    remember({
      kind: 'unwrap',
      txHash: hash,
      chainId: r.chainId,
      toAddress: recipient.value,
      from: evm.account!,
      tokenAddress: r.pair.tokenAddress,
      amount: receive.value.toString(),
      createdAt: Math.floor(Date.now() / 1000),
    })
    toast('Sent. Redeem on Zenon once signed.', 'ok', evmTxUrl(r.chainId, hash) ? { href: evmTxUrl(r.chainId, hash), label: 'View' } : undefined)
    amountText.value = ''
    go('activity')
  } finally {
    sending.value = false
  }
}

// Plasma: a Zenon address with none cannot send without proof of work.
// zenonhub's bot fuses on the build's chain only.
const plasmaBot = computed(() => (onBuildChain() ? config.plasmaBot : { url: '', token: '', page: '' }))
const plasmaBusy = ref(false)
async function getPlasma(address: string) {
  plasmaBusy.value = true
  try {
    const r = await requestPlasma(address, plasmaBot.value)
    if (r.ok) {
      toast(r.message, 'ok')
      setTimeout(checkRecipientPlasma, 20_000)
    } else if (r.page) window.open(r.page, '_blank', 'noopener')
    else toast(r.message, 'danger')
  } finally {
    plasmaBusy.value = false
  }
}

async function addToken() {
  const r = route.value
  if (!r?.evm || !evm.selected) return
  try {
    await ensureChain(r.chainId)
    await watchAsset(evm.selected.provider, { address: r.pair.tokenAddress, symbol: r.evm.symbol, decimals: r.evm.decimals })
  } catch (err) {
    toastError(err)
  }
}

const busy = computed(() => sending.value || approving.value || syrius.busy || evm.busy)
</script>

<template>
  <section class="rise mx-auto grid max-w-[440px] grid-cols-1 gap-2">
    <div class="flex items-center justify-between px-1">
      <span v-if="estimate" class="inline-flex items-center gap-1.5 text-sm text-dim"><Clock :size="14" />~{{ duration(estimate) }}</span>
      <span v-else />
      <button class="adv" data-testid="bridge-advanced" @click="advanced = true">
        Advanced<SlidersHorizontal :size="15" />
        <span v-if="editingRecipient || sendWhileDown" class="adv-dot" />
      </button>
    </div>

    <!-- From -->
    <div class="leg">
      <button class="asset" data-testid="bridge-from" :disabled="!bridge.loaded" @click="openPicker('from')">
        <TokenIcon :symbol="srcSymbol" :chain="srcNet" :size="44" />
        <span class="grid min-w-0 flex-1 text-left">
          <span class="text-lg leading-tight font-semibold">{{ srcSymbol || 'From' }}</span>
          <span class="text-sm text-dim">{{ srcNet }}</span>
        </span>
        <span class="chevron"><ChevronDown :size="16" /></span>
      </button>
      <div class="mt-4 flex items-center gap-3">
        <input v-model="amountText" class="amount-input mono w-0 min-w-0 flex-1" inputmode="decimal" placeholder="0.00" aria-label="Amount" autocomplete="off" />
        <button class="max-btn" @click="setMax">Max</button>
      </div>
      <div class="mt-1 flex h-5 items-center justify-between text-sm text-dim">
        <span>Balance <Amount :value="balance ?? 0n" :decimals="decimals" /></span>
        <span v-if="min" class="text-xs">Min <Amount :value="min" :decimals="decimals" /></span>
      </div>
    </div>

    <div class="relative z-10 -my-5 flex justify-center">
      <button data-testid="bridge-flip" class="flip" :class="{ flipped: dir === 'unwrap' }" aria-label="Reverse direction" @click="flip"><ArrowDownUp :size="17" /></button>
    </div>

    <!-- To -->
    <div class="leg">
      <button class="asset" data-testid="bridge-to" :disabled="!bridge.loaded" @click="openPicker('to')">
        <TokenIcon :symbol="dstSymbol" :chain="dstNet" :size="44" />
        <span class="grid min-w-0 flex-1 text-left">
          <span class="text-lg leading-tight font-semibold">{{ dstSymbol || 'To' }}</span>
          <span class="text-sm text-dim">{{ dstNet }}</span>
        </span>
        <span class="chevron"><ChevronDown :size="16" /></span>
      </button>
      <div data-testid="bridge-receive" class="mono mt-4 truncate text-[30px] leading-[1.25]" :class="receive ? 'text-fg' : 'text-dim'">
        {{ receive ? formatUnits(receive, decimals) : '0.00' }}
      </div>
      <div class="mt-1 flex h-5 items-center gap-1.5 text-sm text-dim">
        <template v-if="recipient">
          <span>To</span><span class="mono truncate" :class="recipientValid ? 'text-soft' : 'text-danger'" :title="recipient">{{ shorten(recipient, 8, 6) }}</span>
          <span v-if="editingRecipient" class="chip chip-dim !h-5">Custom</span>
        </template>
        <span v-else>Connect a wallet to receive</span>
      </div>
    </div>

    <!-- Notes that matter for this transfer -->
    <div v-if="dir === 'wrap' && syrius.address && plasma === 0" class="note warn">
      <Fuel :size="15" /><span class="flex-1">No plasma. Syrius will compute proof of work, which is slow.</span>
      <button v-if="plasmaBot.url || plasmaBot.page" class="btn btn-sm" :disabled="plasmaBusy" @click="getPlasma(syrius.address!)">
        <Loader2 v-if="plasmaBusy" :size="14" class="spin" /><Zap v-else :size="14" />Get plasma
      </button>
    </div>
    <div v-if="dir === 'unwrap' && recipientValid && recipientPlasma === 0" class="note warn">
      <Fuel :size="15" /><span class="flex-1">Recipient has no plasma, needed to redeem on Zenon.</span>
      <button v-if="plasmaBot.url || plasmaBot.page" class="btn btn-sm" :disabled="plasmaBusy" @click="getPlasma(recipient)">
        <Loader2 v-if="plasmaBusy" :size="14" class="spin" /><Zap v-else :size="14" />{{ canRequest(plasmaBot) ? 'Get plasma' : 'Plasma bot' }}
      </button>
    </div>
    <div v-if="bonus" class="note new"><Gift :size="15" />Referral bonus: +1% on arrival.</div>

    <button data-testid="bridge-action" class="btn btn-plasma btn-block mt-2 !min-h-[58px] text-[17px]" :disabled="!actionable || busy" @click="onAction">
      <Loader2 v-if="busy" :size="18" class="spin" />
      <span v-if="syrius.hold">Syrius is busy, retrying in {{ syrius.hold }}s</span>
      <span v-else>{{ actionLabel }}</span>
    </button>

    <!-- The cost and the steps, one tap away. -->
    <div v-if="route" class="mt-1 px-1">
      <button class="details-row" :aria-expanded="details" @click="details = !details">
        <span>{{ dir === 'wrap' ? `Fee ${route.pair.feePercentage / 100}%` : 'No bridge fee' }}</span>
        <span class="flex-1" />
        <span>Details</span><ChevronDown :size="14" class="chev" :class="{ up: details }" />
      </button>
      <dl v-if="details" class="summary slide-down">
        <div v-if="dir === 'wrap'">
          <dt>Fee</dt>
          <dd><Amount :value="fee" :decimals="decimals" :symbol="srcSymbol" /></dd>
        </div>
        <div v-if="estimate">
          <dt>Time</dt>
          <dd>~{{ duration(estimate) }}</dd>
        </div>
        <div>
          <dt>Steps</dt>
          <dd>{{ dir === 'wrap' ? `Send on Zenon, then redeem twice on ${route.networkName}` : (needsApproval ? 'Approve, send, then redeem on Zenon' : 'Send, then redeem on Zenon') }}</dd>
        </div>
        <div v-if="dir === 'wrap' && plasma !== null && plasma > 0 && plasma < LOW_PLASMA">
          <dt>Plasma</dt>
          <dd>Low. Fuse QSR for faster sends.</dd>
        </div>
      </dl>
    </div>

    <!-- One side at a time: the source from every chain, then where it can go. -->
    <Modal :open="picker !== null" :title="picker === 'to' ? 'To' : 'From'" @close="picker = null">
      <div v-if="picker === 'from' && sourceNets.length > 1" class="mb-3 flex flex-wrap gap-2">
        <button v-for="id in sourceNets" :key="id" class="net-pill" :class="{ active: id === pickerNet }" @click="pickerNet = id">
          <TokenIcon :network="id === 'zenon' ? 'Zenon' : evmChain(id).name" :size="20" />{{ id === 'zenon' ? 'Zenon' : evmChain(id).name }}
        </button>
      </div>
      <div class="grid gap-1">
        <button v-for="o in options" :key="o.id" data-testid="bridge-option" class="pick-row" :class="{ active: o.active }" @click="pick(o)">
          <TokenIcon :symbol="o.symbol" :chain="o.network" :size="36" />
          <span class="grid text-left">
            <span class="font-medium">{{ o.symbol }}</span>
            <span class="text-xs text-dim">{{ o.network }}</span>
          </span>
        </button>
        <p v-if="!options.length" class="text-soft">None yet</p>
      </div>
    </Modal>

    <Modal :open="advanced" title="Advanced" @close="advanced = false">
      <div class="grid grid-cols-1 gap-1">
        <button class="menu-row !px-0" data-testid="custom-recipient" @click="toggleCustomRecipient">
          <span class="flex-1 text-left">Custom recipient</span>
          <span class="switch" role="switch" :aria-checked="editingRecipient" />
        </button>
        <input
          v-if="editingRecipient"
          v-model="recipientText"
          class="field mono slide-down mb-2 text-sm"
          :placeholder="dir === 'wrap' ? '0x…' : 'z1…'"
          aria-label="Recipient"
          autocomplete="off"
          spellcheck="false"
        />
        <div v-if="editingRecipient && recipientText && !recipientValid" class="mb-2 text-sm text-danger">Not {{ dir === 'wrap' ? 'an EVM' : 'a Zenon' }} address</div>
        <button v-if="bridgeDown()" class="menu-row !px-0" @click="sendWhileDown = !sendWhileDown">
          <span class="flex-1 text-left">Send while the bridge is down</span>
          <span class="switch" role="switch" :aria-checked="sendWhileDown" />
        </button>
        <button v-if="route?.evm && evm.selected" class="menu-row !px-0" @click="addToken">
          <span class="flex-1 text-left">Add {{ route.evm.symbol }} to wallet</span><Plus :size="16" />
        </button>
      </div>
    </Modal>

    <Terms :open="termsOpen" @close="termsOpen = false" @accepted="((termsOpen = false), onAction())" />
  </section>
</template>

<style scoped>
.adv {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 0 4px;
  font-size: 13px;
  color: var(--dim);
  transition: color 180ms var(--ease);
}
.adv:hover {
  color: var(--fg);
}
.adv svg {
  transition: transform 320ms var(--spring);
}
.adv:hover svg {
  transform: rotate(90deg);
}
.adv-dot {
  position: absolute;
  top: 10px;
  right: -2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
}
.leg {
  padding: 18px 20px 16px;
  border-radius: var(--radius-card);
  background: var(--card-glass);
  backdrop-filter: blur(10px);
  border: 1px solid var(--line);
  box-shadow: var(--edge), var(--shadow-panel);
  --icon-ring: var(--surface);
  transition:
    border-color 180ms var(--ease),
    box-shadow 180ms var(--ease);
}
.leg:focus-within {
  border-color: var(--line-strong);
}
.asset {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  min-height: 48px;
}
.chevron {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  color: var(--soft);
  transition:
    background 180ms var(--ease),
    color 180ms var(--ease),
    transform 260ms var(--spring);
}
.asset:hover:not(:disabled) .chevron {
  background: var(--raised);
  color: var(--fg);
  transform: translateY(2px);
}
.asset:active:not(:disabled) .chevron {
  transform: scale(0.92);
}
.amount-input {
  background: transparent;
  border: 0;
  outline: none;
  font-size: 30px;
  line-height: 1.25;
  color: var(--fg);
  padding: 0;
}
.amount-input::placeholder {
  color: var(--dim);
}
.max-btn {
  min-height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  transition:
    background 180ms var(--ease),
    border-color 180ms var(--ease),
    transform 220ms var(--spring);
}
.max-btn:hover {
  background: var(--raised);
  border-color: var(--dim);
  transform: translateY(-1px);
}
.max-btn:active {
  transform: scale(0.94);
}
.flip {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  color: var(--soft);
  box-shadow: 0 0 0 4px var(--bg);
  transition:
    transform 420ms var(--spring),
    color 180ms var(--ease),
    border-color 180ms var(--ease);
}
.flip:hover {
  color: var(--znn-ink);
  border-color: var(--znn-ink);
  transform: rotate(180deg);
}
.flip.flipped {
  transform: rotate(180deg);
}
.flip.flipped:hover {
  transform: rotate(360deg);
}
.note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 16px;
  font-size: 14px;
  color: var(--soft);
  background: var(--sunk);
}
.note.warn {
  color: var(--warn);
  background: var(--warn-bg);
}
.note.new {
  color: var(--new-ink);
  background: var(--new-bg);
}
.details-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 44px;
  font-size: 13px;
  color: var(--dim);
  transition: color 180ms var(--ease);
}
.details-row:hover {
  color: var(--fg);
}
.chev {
  transition: transform 220ms var(--spring);
}
.chev.up {
  transform: rotate(180deg);
}
.summary {
  display: grid;
  gap: 8px;
  padding-bottom: 8px;
  font-size: 14px;
}
.summary > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.summary dt {
  color: var(--dim);
}
.summary dd {
  text-align: right;
  color: var(--soft);
}
.net-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 0 14px 0 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  font-size: 14px;
  color: var(--soft);
  transition:
    background 180ms var(--ease),
    color 180ms var(--ease),
    border-color 180ms var(--ease);
}
.net-pill:hover,
.net-pill.active {
  color: var(--fg);
  background: var(--raised);
  border-color: var(--line-strong);
}
.pick-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 64px;
  padding: 0 12px;
  border-radius: var(--radius);
  --icon-ring: var(--surface);
  transition:
    background 180ms var(--ease),
    transform 220ms var(--spring);
}
.pick-row:hover,
.pick-row.active {
  background: var(--raised);
  --icon-ring: var(--raised);
}
.pick-row:active {
  transform: scale(0.985);
}
</style>
