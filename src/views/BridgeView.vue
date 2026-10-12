<script setup lang="ts">
// Move a token between Zenon and an EVM network.
//
// Wrap (Zenon to EVM) is one Syrius send to the bridge contract; the EVM
// redeem happens later, from Activity. Unwrap (EVM to Zenon) is an ERC-20
// approve, if the allowance is short, then `unwrap` on the EVM bridge; the
// Zenon redeem happens later, from Activity.
import { computed, onUnmounted, ref, watch } from 'vue'
import { ArrowDownUp, ArrowRight, ChevronDown, Clock, Fuel, Gift, Plus, Loader2, SlidersHorizontal, Zap } from '@lucide/vue'
import TokenIcon from '../components/TokenIcon.vue'
import Amount from '../components/Amount.vue'
import Modal from '../components/Modal.vue'
import Terms from '../components/Terms.vue'
import { bridge, transferBlocker, nodeContext, type Route } from '../state/bridge.ts'
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
import { isUserAddress } from '../znn/primitives.ts'
import { isEvmRecipient } from '../core/recipient.ts'
import { operations, unresolvedOperation } from '../state/operations.ts'
import { submitTransaction, successfulReceipt, transactionPayload } from '../evm/transactions.ts'
import { parseUnits, unitsToInput, duration, formatUnits, shorten } from '../core/format.ts'
import { wrapFee, wrapReceive, unwrapReceive, wrapEstimate, unwrapEstimate, LOW_PLASMA } from '../core/fees.ts'
import { usableReferrer, recipientString } from '../core/referral.ts'
import { requestPlasma, canRequest } from '../core/plasmaBot.ts'
import { watchAsset } from '../wallet/eip6963.ts'
import { config, evmChain, evmTxUrl } from '../config.ts'

type Dir = 'wrap' | 'unwrap'
const dir = ref<Dir>('wrap')
let mounted = true
onUnmounted(() => { mounted = false; balanceRequest++; recipientRequest++ })
const chainId = ref<number | null>(null)
const routeKey = ref<string>('')
const amountText = ref('')
const recipientText = ref('')
const editingRecipient = ref(false)
const picker = ref(false)
const advanced = ref(false)
const details = ref(false)
const termsOpen = ref(false)
const sending = ref(false)
const approving = ref(false)

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

let balanceRequest = 0
const balanceContext = () => JSON.stringify([nodeContext(), route.value?.key, dir.value, syrius.address, evm.account, evm.chainId, evm.selected?.info.uuid])
async function refreshBalances() {
  const request = ++balanceRequest, key = balanceContext(), r = route.value, a = api.value
  const current = () => request === balanceRequest && key === balanceContext() && a === api.value
  balance.value = null; allowance.value = null; plasma.value = null
  if (!r || !a) return
  try {
    if (dir.value === 'wrap') {
      const account = syrius.address
      if (!account) return
      const [b, p] = await Promise.all([a.balances(account), a.plasma(account)])
      if (current()) { balance.value = b[r.pair.tokenStandard] ?? 0n; plasma.value = p.currentPlasma }
    } else {
      const account = evm.account
      if (!account || evm.chainId !== r.chainId) return
      const c = readClient(r.chainId, walletForReads()), token = r.pair.tokenAddress as `0x${string}`
      const [b, allowed] = await Promise.all([
        c.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
        c.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, r.contract] }),
      ])
      if (current()) { balance.value = b; allowance.value = allowed }
    }
  } catch { /* unknown balances never authorize a send */ }
}
watch([route, dir, () => api.value, () => node.epoch, () => syrius.address, () => evm.account, () => evm.chainId, () => evm.selected], refreshBalances, { immediate: true, flush: 'sync' })
watch(() => node.tick, (t) => t % 3 === 0 && refreshBalances())

// Recipient: the connected wallet on the receiving side, unless edited.
const defaultRecipient = computed(() => (dir.value === 'wrap' ? (evm.account ?? '') : (syrius.address ?? '')))
const recipient = computed(() => (editingRecipient.value ? recipientText.value.trim() : defaultRecipient.value))
const recipientValid = computed(() =>
  dir.value === 'wrap' ? isEvmRecipient(recipient.value) : isUserAddress(recipient.value),
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
  if (busy.value) return
  editingRecipient.value = !editingRecipient.value
  recipientText.value = editingRecipient.value ? defaultRecipient.value : ''
}
watch(dir, (_n, old) => {
  if (old === undefined) return
  editingRecipient.value = false
  recipientText.value = ''
  amountText.value = ''
})

let recipientRequest = 0
async function checkRecipientPlasma() {
  const request = ++recipientRequest, key = nodeContext(), address = recipient.value, a = api.value
  recipientPlasma.value = null
  if (dir.value !== 'unwrap' || !recipientValid.value) return
  try {
    const result = await a.plasma(address)
    if (request === recipientRequest && nodeContext() === key && recipient.value === address && api.value === a) recipientPlasma.value = result.currentPlasma
  } catch {
    /* unknown */
  }
}
watch([recipient, dir, () => api.value, () => node.epoch], checkRecipientPlasma, { immediate: true })

const amount = computed(() => parseUnits(amountText.value, decimals.value))
const min = computed(() => {
  const r = route.value
  if (!r) return 0n
  return dir.value === 'wrap' ? r.pair.minAmount : (r.evmInfo?.minAmount ?? 0n)
})
const fee = computed(() => (dir.value === 'wrap' && amount.value && route.value ? wrapFee(amount.value, route.value.pair.feePercentage) : 0n))
const bonus = computed(
  () => dir.value === 'unwrap' && !!usableReferrer(recipient.value, referrer.value) && !!route.value && bridge.loaded && affiliateActive(bridge.meta, route.value.chainId, route.value.pair.tokenStandard, bridge.evmNetworks[route.value.chainId]?.height ?? undefined),
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
  if (busy.value) return
  if (balance.value !== null) amountText.value = unitsToInput(balance.value, decimals.value)
}

function flip() {
  if (busy.value) return
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
  if (amount.value === null) return 'Use a decimal dot; no grouping separators'
  if (amount.value === 0n) return 'Enter an amount'
  if (amount.value < min.value) return `Minimum ${formatUnits(min.value, decimals.value)} ${srcSymbol.value}`
  if (balance.value !== null && amount.value > balance.value) return `Not enough ${srcSymbol.value}`
  if (!recipient.value) return dir.value === 'wrap' ? 'Connect EVM wallet or enter recipient' : 'Connect Syrius or enter recipient'
  if (!recipientValid.value) return 'Invalid recipient'
  if (operations.error) return 'Operation history unavailable'
  const source = dir.value === 'wrap' ? 'zenon' : 'evm'
  const account = dir.value === 'wrap' ? syrius.address : evm.account
  const sourceChain = dir.value === 'wrap' ? node.chainId : route.value.chainId
  if (account && unresolvedOperation(source, sourceChain, account)) return 'Resolve the earlier operation in Activity'
  const safety = transferBlocker(route.value, dir.value)
  if (safety) return safety
  if (balance.value === null || dir.value === 'unwrap' && allowance.value === null) return 'Balance or allowance unavailable'
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

function snapshot() {
  const selected = route.value
  if (!selected || !amount.value || !recipientValid.value) throw new Error('Transfer details are unavailable')
  const r = { ...selected, pair: { ...selected.pair } }
  const captured = { r, amount: amount.value, receive: receive.value, recipient: recipient.value, znn: node.chainId,
    account: dir.value === 'wrap' ? syrius.address! : evm.account!, provider: evm.selected?.provider,
    nodeKey: nodeContext(), bonus: bonus.value, referral: referrer.value, createdAt: Math.floor(Date.now() / 1000) }
  const direction = dir.value
  const economics = (value: Route | undefined) => JSON.stringify([value?.pair, value?.evmInfo, value?.zts?.decimals, value?.evm?.decimals, bridge.info?.compressedTssECDSAPubKey, bridge.info?.metadata], (_key, value) => typeof value === 'bigint' ? value.toString() : value)
  const chosenEconomics = economics(r)
  const guard = () => {
    if (!mounted) throw new Error('Transfer view changed before submission')
    if (nodeContext() !== captured.nodeKey || direction !== dir.value || (direction === 'wrap' ? syrius.address : evm.account) !== captured.account ||
      direction === 'unwrap' && (evm.selected?.provider !== captured.provider || evm.chainId !== r.chainId)) throw new Error('Wallet or network changed before submission')
    const currentRoute = bridge.routes.find((x) => x.key === r.key)
    if (economics(currentRoute) !== chosenEconomics) throw new Error('Transfer configuration changed before submission. Review the current amount and limits.')
    const safety = transferBlocker(currentRoute, direction)
    if (safety || !bridge.routes.some((x) => x.key === r.key)) throw new Error(safety || 'Route changed before submission')
  }
  return { ...captured, guard }
}

async function sendWrap() {
  const s = snapshot()
  sending.value = true
  try {
    s.guard()
    const hash = await sendBlock(wrapTokenBlock({ networkClass: s.r.networkClass, chainId: s.r.chainId, toAddress: s.recipient, tokenStandard: s.r.pair.tokenStandard, amount: s.amount }), s.guard)
    remember({ kind: 'wrap', id: hash, znn: s.znn, contract: s.r.contract, chainId: s.r.chainId, toAddress: s.recipient.toLowerCase(),
      from: s.account, tokenStandard: s.r.pair.tokenStandard, amount: s.receive.toString(), createdAt: s.createdAt })
    toast(`Submitted. Redeem on ${s.r.networkName} once signed.`, 'wait', { href: s.znn === config.zenonChainId ? config.zenonExplorerTx(hash) : '', label: 'View' })
    if (mounted) { amountText.value = ''; go('activity') }
  } finally { sending.value = false }
}

async function approve() {
  const s = snapshot()
  approving.value = true
  try {
    await ensureChain(s.r.chainId)
    s.guard()
    const w = writeClient(s.r.chainId, s.provider!, s.account as `0x${string}`)
    const token = s.r.pair.tokenAddress as `0x${string}`, args = [s.r.contract, s.amount] as const
    const hash = await submitTransaction({ chainId: s.r.chainId, account: s.account, kind: 'approve', payload: transactionPayload(token, erc20Abi, 'approve', args) }, s.guard,
      () => w.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args, chain: w.chain, account: s.account as `0x${string}` }))
    toast('Approval submitted', 'wait')
    await successfulReceipt(readClient(s.r.chainId, { provider: s.provider!, chainId: s.r.chainId }), s.r.chainId, hash)
    await refreshBalances()
  } finally { approving.value = false }
}

async function sendUnwrap() {
  const s = snapshot()
  sending.value = true
  try {
    await ensureChain(s.r.chainId)
    s.guard()
    const w = writeClient(s.r.chainId, s.provider!, s.account as `0x${string}`)
    const to = recipientString(s.recipient, s.bonus ? s.referral : null)
    const args = [s.r.pair.tokenAddress as `0x${string}`, s.amount, to] as const
    const hash = await submitTransaction({ chainId: s.r.chainId, account: s.account, kind: 'unwrap', payload: transactionPayload(s.r.contract, bridgeAbi, 'unwrap', args) }, s.guard,
      () => w.writeContract({ address: s.r.contract, abi: bridgeAbi, functionName: 'unwrap', args, chain: w.chain, account: s.account as `0x${string}` }))
    remember({ kind: 'unwrap', txHash: hash, znn: s.znn, contract: s.r.contract, chainId: s.r.chainId, toAddress: s.recipient,
      from: s.account, tokenAddress: s.r.pair.tokenAddress, amount: s.receive.toString(), createdAt: s.createdAt })
    toast('Submitted. Redeem on Zenon once signed.', 'wait', evmTxUrl(s.r.chainId, hash) ? { href: evmTxUrl(s.r.chainId, hash), label: 'View' } : undefined)
    await successfulReceipt(readClient(s.r.chainId, { provider: s.provider!, chainId: s.r.chainId }), s.r.chainId, hash)
    if (mounted) { amountText.value = ''; go('activity') }
  } finally { sending.value = false }
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
    <h1 class="sr-only">Bridge</h1>
    <div class="flex items-center justify-between px-1">
      <span v-if="estimate" class="inline-flex items-center gap-1.5 text-sm text-dim"><Clock :size="14" />~{{ duration(estimate) }}</span>
      <span v-else />
      <button class="adv" data-testid="bridge-advanced" :disabled="busy" @click="advanced = true">
        Advanced<SlidersHorizontal :size="15" />
        <span v-if="editingRecipient" class="adv-dot" />
      </button>
    </div>

    <!-- From -->
    <div class="leg">
      <button class="asset" :disabled="busy || !bridge.loaded" @click="picker = true">
        <TokenIcon :symbol="srcSymbol" :chain="srcNet" :size="44" />
        <span class="grid min-w-0 flex-1 text-left">
          <span class="text-lg leading-tight font-semibold">{{ srcSymbol || 'From' }}</span>
          <span class="text-sm text-dim">{{ srcNet }}</span>
        </span>
        <span class="chevron"><ChevronDown :size="16" /></span>
      </button>
      <div class="mt-4 flex items-center gap-3">
        <input v-model="amountText" :disabled="busy" class="amount-input mono w-0 min-w-0 flex-1" inputmode="decimal" placeholder="0.00" aria-label="Amount" autocomplete="off" />
        <button class="max-btn" :disabled="busy" @click="setMax">Max</button>
      </div>
      <div class="mt-1 flex h-5 items-center justify-between text-sm text-dim">
        <span>Balance <Amount :value="balance ?? 0n" :decimals="decimals" /></span>
        <span v-if="min" class="text-xs">Min <Amount :value="min" :decimals="decimals" /></span>
      </div>
    </div>

    <div class="relative z-10 -my-5 flex justify-center">
      <button data-testid="bridge-flip" :disabled="busy" class="flip" :class="{ flipped: dir === 'unwrap' }" aria-label="Reverse direction" @click="flip"><ArrowDownUp :size="17" /></button>
    </div>

    <!-- To -->
    <div class="leg">
      <button class="asset" :disabled="busy || !bridge.loaded" @click="picker = true">
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

    <!-- Asset: the network and the token, in one place. -->
    <Modal :open="picker" title="Select asset" @close="picker = false">
      <div v-if="chains.length > 1" class="mb-3 flex flex-wrap gap-2">
        <button v-for="id in chains" :key="id" :disabled="busy" class="net-pill" :class="{ active: id === chainId }" @click="chainId = id">
          <TokenIcon :network="evmChain(id).name" :size="20" />{{ evmChain(id).name }}
        </button>
      </div>
      <div class="grid gap-1">
        <button v-for="r in routes" :key="r.key" :disabled="busy" class="pick-row" :class="{ active: r.key === routeKey }" @click="((routeKey = r.key), (picker = false))">
          <TokenIcon :symbol="dir === 'wrap' ? r.zts?.symbol : r.evm?.symbol" :chain="dir === 'wrap' ? 'Zenon' : r.networkName" :size="36" />
          <span class="grid text-left">
            <span class="font-medium">{{ dir === 'wrap' ? r.zts?.symbol : r.evm?.symbol }}</span>
            <span class="text-xs text-dim">{{ dir === 'wrap' ? 'Zenon' : r.networkName }}</span>
          </span>
          <ArrowRight :size="14" class="mx-1 text-dim" />
          <TokenIcon :symbol="dir === 'wrap' ? r.evm?.symbol : r.zts?.symbol" :chain="dir === 'wrap' ? r.networkName : 'Zenon'" :size="36" />
          <span class="grid text-left">
            <span class="font-medium">{{ dir === 'wrap' ? r.evm?.symbol : r.zts?.symbol }}</span>
            <span class="text-xs text-dim">{{ dir === 'wrap' ? r.networkName : 'Zenon' }}</span>
          </span>
          <span v-if="dir === 'wrap' && r.pair.feePercentage" class="ml-auto text-xs text-dim">{{ r.pair.feePercentage / 100 }}%</span>
        </button>
        <p v-if="!routes.length" class="text-soft">None yet</p>
      </div>
    </Modal>

    <Modal :open="advanced" title="Advanced" @close="advanced = false">
      <div class="grid grid-cols-1 gap-1">
        <button class="menu-row !px-0" data-testid="custom-recipient" :disabled="busy" @click="toggleCustomRecipient">
          <span class="flex-1 text-left">Custom recipient</span>
          <span class="switch" role="switch" :aria-checked="editingRecipient" />
        </button>
        <input
          v-if="editingRecipient"
          v-model="recipientText" :disabled="busy"
          class="field mono slide-down mb-2 text-sm"
          :placeholder="dir === 'wrap' ? '0x…' : 'z1…'"
          aria-label="Recipient"
          autocomplete="off"
          spellcheck="false"
        />
        <div v-if="editingRecipient && recipientText && !recipientValid" class="mb-2 text-sm text-danger">Not {{ dir === 'wrap' ? 'an EVM' : 'a Zenon' }} address</div>
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
