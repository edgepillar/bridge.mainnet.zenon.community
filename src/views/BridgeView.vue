<script setup lang="ts">
// Move a token between Zenon and an EVM network.
//
// Wrap (Zenon to EVM) is one Syrius send to the bridge contract; the EVM
// redeem happens later, from Activity. Unwrap (EVM to Zenon) is an ERC-20
// approve, if the allowance is short, then `unwrap` on the EVM bridge; the
// Zenon redeem happens later, from Activity.
import { computed, ref, watch } from 'vue'
import { ArrowDownUp, ChevronDown, Pencil, Clock, Fuel, Plus, Loader2, Zap } from 'lucide-vue-next'
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
import { parseUnits, unitsToInput, duration, formatUnits } from '../core/format.ts'
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
const tokenPicker = ref(false)
const networkPicker = ref(false)
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
const net = computed(() => (chainId.value ? evmChain(chainId.value) : null))
const evmNet = computed(() => (chainId.value ? bridge.evmNetworks[chainId.value] : undefined))

// What the user holds on the sending side, and the token's units there.
const srcSymbol = computed(() => (dir.value === 'wrap' ? route.value?.zts?.symbol : route.value?.evm?.symbol) ?? '')
const dstSymbol = computed(() => (dir.value === 'wrap' ? route.value?.evm?.symbol : route.value?.zts?.symbol) ?? '')
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
  <section class="rise mx-auto grid max-w-[480px] grid-cols-1 gap-4">
    <div class="panel p-4 md:p-5">
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-semibold">Bridge</h1>
        <span v-if="estimate" class="inline-flex items-center gap-1.5 text-sm text-dim"><Clock :size="14" />~{{ duration(estimate) }}</span>
      </div>

      <!-- From -->
      <div class="leg well p-3">
        <div class="mb-2 flex items-center justify-between">
          <span class="label">From</span>
          <button v-if="dir === 'unwrap'" class="net-btn" @click="networkPicker = true">
            <TokenIcon :network="net?.name ?? ''" :size="18" />{{ net?.name }}<ChevronDown :size="14" />
          </button>
          <span v-else class="net-btn static"><TokenIcon network="Zenon" :size="18" />Zenon</span>
        </div>
        <div class="flex items-center gap-3">
          <input
            v-model="amountText"
            class="amount-input mono w-0 min-w-0 flex-1"
            inputmode="decimal"
            placeholder="0"
            aria-label="Amount"
            autocomplete="off"
          />
          <button class="token-btn" :disabled="!routes.length" @click="tokenPicker = true">
            <TokenIcon :symbol="srcSymbol" :size="22" />
            <span class="font-medium">{{ srcSymbol || 'Token' }}</span>
            <ChevronDown :size="15" class="text-dim" />
          </button>
        </div>
        <div class="mt-2 flex h-5 items-center justify-between text-sm text-dim">
          <span>
            Balance <Amount :value="balance ?? 0n" :decimals="decimals" />
            <button class="max-btn" @click="setMax">Max</button>
          </span>
          <span v-if="min" class="text-xs">Min <Amount :value="min" :decimals="decimals" /></span>
        </div>
      </div>

      <div class="relative z-10 -my-3 flex justify-center">
        <button data-testid="bridge-flip" class="flip" :class="{ flipped: dir === 'unwrap' }" aria-label="Reverse direction" @click="flip"><ArrowDownUp :size="18" /></button>
      </div>

      <!-- To -->
      <div class="leg well p-3">
        <div class="mb-2 flex items-center justify-between">
          <span class="label">To</span>
          <button v-if="dir === 'wrap'" class="net-btn" @click="networkPicker = true">
            <TokenIcon :network="net?.name ?? ''" :size="18" />{{ net?.name }}<ChevronDown :size="14" />
          </button>
          <span v-else class="net-btn static"><TokenIcon network="Zenon" :size="18" />Zenon</span>
        </div>
        <div class="flex items-center gap-3">
          <div data-testid="bridge-receive" class="mono min-w-0 flex-1 truncate text-2xl" :class="receive ? 'text-fg' : 'text-dim'">
            {{ receive ? formatUnits(receive, decimals) : '0' }}
          </div>
          <span class="token-btn static"><TokenIcon :symbol="dstSymbol" :size="22" /><span class="font-medium">{{ dstSymbol }}</span></span>
        </div>
        <div class="mt-3 flex min-h-[28px] items-center gap-2 text-sm">
          <span class="text-dim">Recipient</span>
          <template v-if="!editingRecipient">
            <span v-if="recipient" class="mono truncate text-soft">{{ recipient }}</span>
            <span v-else class="text-dim">connect or enter</span>
            <button class="ml-auto inline-flex h-7 w-7 shrink-0 place-items-center justify-center rounded text-dim hover:bg-raised hover:text-fg" aria-label="Edit recipient" @click="((editingRecipient = true), (recipientText = recipient))">
              <Pencil :size="13" />
            </button>
          </template>
          <input
            v-else
            v-model="recipientText"
            class="field mono !min-h-[36px] flex-1 text-sm"
            :placeholder="dir === 'wrap' ? '0x…' : 'z1…'"
            aria-label="Recipient"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
      </div>

      <!-- Notes that matter for this transfer -->
      <div class="mt-3 grid gap-2 text-sm">
        <div v-if="dir === 'wrap' && syrius.address && plasma === 0" class="note warn">
          <Fuel :size="15" /><span class="flex-1">No plasma. Syrius will compute proof of work, which is slow.</span>
          <button v-if="plasmaBot.url || plasmaBot.page" class="btn btn-sm" :disabled="plasmaBusy" @click="getPlasma(syrius.address!)">
            <Loader2 v-if="plasmaBusy" :size="14" class="spin" /><Zap v-else :size="14" />Get plasma
          </button>
        </div>
        <div v-else-if="dir === 'wrap' && plasma !== null && plasma > 0 && plasma < LOW_PLASMA" class="note">
          <Fuel :size="15" /><span>Low plasma. Fuse QSR for faster sends.</span>
        </div>
        <div v-if="dir === 'unwrap' && recipientValid && recipientPlasma === 0" class="note warn">
          <Fuel :size="15" /><span class="flex-1">Recipient has no plasma, needed to redeem on Zenon.</span>
          <button v-if="plasmaBot.url || plasmaBot.page" class="btn btn-sm" :disabled="plasmaBusy" @click="getPlasma(recipient)">
            <Loader2 v-if="plasmaBusy" :size="14" class="spin" /><Zap v-else :size="14" />{{ canRequest(plasmaBot) ? 'Get plasma' : 'Plasma bot' }}
          </button>
        </div>
        <div v-if="bonus" class="note new">Referral bonus: +1% on arrival.</div>
      </div>

      <dl v-if="route && amount" class="summary mt-3">
        <div v-if="dir === 'wrap'">
          <dt>Fee {{ route.pair.feePercentage / 100 }}%</dt>
          <dd><Amount :value="fee" :decimals="decimals" :symbol="srcSymbol" /></dd>
        </div>
        <div>
          <dt>Steps</dt>
          <dd>{{ dir === 'wrap' ? `Send on Zenon, then redeem twice on ${route.networkName}` : (needsApproval ? 'Approve, send, then redeem on Zenon' : 'Send, then redeem on Zenon') }}</dd>
        </div>
      </dl>

      <label v-if="bridgeDown()" class="mt-3 flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-soft">
        <input v-model="sendWhileDown" type="checkbox" class="h-4 w-4 accent-[var(--warn)]" />
        Send anyway. It waits until the bridge is back.
      </label>

      <button data-testid="bridge-action" class="btn btn-plasma btn-block mt-4 !min-h-[52px] text-base" :disabled="!actionable || busy" @click="onAction">
        <Loader2 v-if="busy" :size="18" class="spin" />
        <span v-if="syrius.hold">Syrius is busy, retrying in {{ syrius.hold }}s</span>
        <span v-else>{{ actionLabel }}</span>
      </button>

      <div v-if="dir === 'wrap' && route?.evm && evm.selected" class="mt-2 text-center">
        <button class="btn btn-ghost btn-sm" @click="addToken"><Plus :size="14" />Add {{ route.evm.symbol }} to wallet</button>
      </div>
    </div>

    <Modal :open="tokenPicker" title="Token" @close="tokenPicker = false">
      <div class="grid gap-1">
        <button
          v-for="r in routes"
          :key="r.key"
          class="pick-row"
          :class="{ active: r.key === routeKey }"
          @click="((routeKey = r.key), (tokenPicker = false))"
        >
          <TokenIcon :symbol="dir === 'wrap' ? r.zts?.symbol : r.evm?.symbol" :size="28" />
          <span class="grid text-left">
            <span class="font-medium">{{ dir === 'wrap' ? r.zts?.symbol : r.evm?.symbol }}</span>
            <span class="text-xs text-dim">to {{ dir === 'wrap' ? r.evm?.symbol : r.zts?.symbol }} · {{ dir === 'wrap' ? r.zts?.name : r.evm?.name }}</span>
          </span>
          <span v-if="dir === 'wrap' && r.pair.feePercentage" class="ml-auto text-xs text-dim">{{ r.pair.feePercentage / 100 }}% fee</span>
        </button>
        <p v-if="!routes.length" class="text-soft">None yet</p>
      </div>
    </Modal>

    <Modal :open="networkPicker" title="Network" @close="networkPicker = false">
      <div class="grid gap-1">
        <button
          v-for="id in chains"
          :key="id"
          class="pick-row"
          :class="{ active: id === chainId }"
          @click="((chainId = id), (networkPicker = false))"
        >
          <TokenIcon :network="evmChain(id).name" :size="28" />
          <span class="font-medium">{{ evmChain(id).name }}</span>
          <span class="mono ml-auto text-xs text-dim">{{ id }}</span>
        </button>
      </div>
    </Modal>

    <Terms :open="termsOpen" @close="termsOpen = false" @accepted="((termsOpen = false), onAction())" />
  </section>
</template>

<style scoped>
.leg {
  transition: border-color 150ms var(--ease);
}
.leg:focus-within {
  border-color: var(--line-strong);
}
.amount-input {
  background: transparent;
  border: 0;
  outline: none;
  font-size: 28px;
  line-height: 1.2;
  color: var(--fg);
  padding: 4px 0;
}
.amount-input::placeholder {
  color: var(--dim);
}
.token-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 10px 0 8px;
  border-radius: 999px;
  background: var(--raised);
  border: 1px solid var(--line);
  transition: border-color 150ms var(--ease);
}
.token-btn:not(.static):hover {
  border-color: var(--line-strong);
}
.token-btn.static {
  padding-right: 14px;
}
.net-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 8px;
  margin: -6px -8px;
  border-radius: var(--radius);
  font-size: 14px;
  color: var(--soft);
  transition: background 150ms var(--ease);
}
.net-btn:not(.static):hover {
  background: var(--raised);
  color: var(--fg);
}
.max-btn {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--znn-ink);
  background: var(--ok-bg);
}
.flip {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  color: var(--soft);
  transition:
    transform 320ms var(--spring),
    color 150ms var(--ease),
    border-color 150ms var(--ease);
}
.flip:hover {
  color: var(--fg);
  border-color: var(--dim);
}
.flip.flipped {
  transform: rotate(180deg);
}
.note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius);
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
.summary {
  display: grid;
  gap: 6px;
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
.pick-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 0 12px;
  border-radius: var(--radius);
  transition: background 150ms var(--ease);
}
.pick-row:hover,
.pick-row.active {
  background: var(--raised);
}
</style>
