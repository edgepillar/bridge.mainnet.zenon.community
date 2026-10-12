<script setup lang="ts">
// The two wallets, side by side: Syrius for Zenon, any EIP-6963 wallet for EVM.
import { computed, ref } from 'vue'
import { Wallet, LogOut, ChevronDown, Download, Loader2 } from 'lucide-vue-next'
import Modal from './Modal.vue'
import TokenIcon from './TokenIcon.vue'
import syriusLogo from '../assets/syrius-logo.svg'
import {
  syrius,
  connectSyrius,
  disconnectSyrius,
  node,
  hostOf,
  chainId,
  networkLabel,
  walletNode,
  requestWalletNode,
  confirmWalletNode,
  cancelWalletNode,
  useDefaultNode,
} from '../state/zenon.ts'
import { evm, connectEvm, disconnectEvm } from '../state/evm.ts'
import { evmChain, zenonNetworkName } from '../config.ts'
import { shorten } from '../core/format.ts'
import { toastError } from '../state/toasts.ts'
import type { DiscoveredWallet } from '../wallet/eip6963.ts'

const menu = ref<'' | 'znn' | 'evm'>('')

async function onSyrius() {
  if (syrius.address) return void (menu.value = menu.value === 'znn' ? '' : 'znn')
  if (!syrius.present) return window.open('https://github.com/DexterLabZ/syrius-extension/releases', '_blank', 'noopener')
  try {
    await connectSyrius()
  } catch (err) {
    toastError(err)
  }
}

async function pick(w: DiscoveredWallet) {
  try {
    await connectEvm(w)
    evm.pickerOpen = false
  } catch (err) {
    toastError(err)
  }
}

function onEvm() {
  if (evm.account) menu.value = menu.value === 'evm' ? '' : 'evm'
  else evm.pickerOpen = true
}

function toggleNode() {
  if (node.source === 'wallet') useDefaultNode()
  else void requestWalletNode()
}

const chainName = computed(() => (evm.chainId ? evmChain(evm.chainId).name : ''))
</script>

<template>
  <div class="relative flex items-center gap-2">
    <button data-testid="wallet-zenon" class="btn btn-sm wallet" :aria-label="syrius.address ? 'Syrius ' + syrius.address : 'Syrius'" :class="{ connected: syrius.address }" :disabled="syrius.busy" @click="onSyrius">
      <img :src="syriusLogo" width="18" height="18" alt="" class="rounded-sm" />
      <span v-if="syrius.hold" class="mono">{{ syrius.hold }}s</span>
      <span v-else-if="syrius.address" class="mono hidden md:inline">{{ shorten(syrius.address, 5, 4) }}</span>
      <span v-else-if="syrius.present">Syrius</span>
      <span v-else class="inline-flex items-center gap-1"><Download :size="14" />Syrius</span>
    </button>
    <button data-testid="wallet-evm" class="btn btn-sm wallet" :aria-label="evm.account ? 'EVM wallet ' + evm.account : 'EVM wallet'" :class="{ connected: evm.account }" :disabled="evm.busy" @click="onEvm">
      <img v-if="evm.selected?.info.icon" :src="evm.selected.info.icon" width="18" height="18" alt="" />
      <TokenIcon v-else-if="evm.account" :network="chainName" :size="18" />
      <Wallet v-else :size="16" />
      <span v-if="evm.account" class="mono hidden md:inline">{{ shorten(evm.account, 5, 4) }}</span>
      <span v-else>EVM</span>
    </button>

    <Transition name="fade">
      <div v-if="menu" class="menu panel" @mouseleave="menu = ''">
        <template v-if="menu === 'znn' && syrius.address">
          <div class="label mb-1">Zenon</div>
          <div class="mono break-all text-sm">{{ syrius.address }}</div>
          <div class="label mt-4 mb-1">Node</div>
          <div class="flex items-center gap-2">
            <span class="mono min-w-0 flex-1 truncate text-sm" :title="node.url">{{ hostOf(node.url) }}</span>
            <span class="chip chip-dim mono">{{ networkLabel() }} {{ chainId() }}</span>
          </div>
          <button class="node-switch" data-testid="node-switch" :disabled="walletNode.checking" @click="toggleNode">
            <span class="flex-1 text-left">Use Syrius node</span>
            <Loader2 v-if="walletNode.checking" :size="15" class="spin text-dim" />
            <span class="switch" role="switch" :aria-checked="node.source === 'wallet'" />
          </button>
          <div v-if="walletNode.problem" class="text-sm text-warn">{{ walletNode.problem }}</div>
          <button class="btn btn-ghost btn-sm btn-block mt-3 !justify-start" @click="(disconnectSyrius(), (menu = ''))"><LogOut :size="15" />Disconnect</button>
        </template>
        <template v-if="menu === 'evm' && evm.account">
          <div class="label mb-1">{{ evm.selected?.info.name }} · {{ chainName }}</div>
          <div class="mono break-all text-sm">{{ evm.account }}</div>
          <button class="btn btn-ghost btn-sm btn-block mt-3 !justify-start" @click="((evm.pickerOpen = true), (menu = ''))"><ChevronDown :size="15" />Switch wallet</button>
          <button class="btn btn-ghost btn-sm btn-block !justify-start" @click="(disconnectEvm(), (menu = ''))"><LogOut :size="15" />Disconnect</button>
        </template>
      </div>
    </Transition>

    <Modal :open="!!walletNode.pending" title="Confirm network" @close="cancelWalletNode">
      <div v-if="walletNode.pending" class="grid grid-cols-1 gap-4">
        <div class="well grid grid-cols-1 gap-3 p-4">
          <div>
            <div class="label">Network</div>
            <div class="text-2xl font-semibold" data-testid="node-network">{{ zenonNetworkName(walletNode.pending.chainId) }}</div>
          </div>
          <div class="flex gap-6">
            <div>
              <div class="label">Chain</div>
              <div class="mono">{{ walletNode.pending.chainId }}</div>
            </div>
            <div class="min-w-0">
              <div class="label">Syrius node</div>
              <div class="mono truncate" :title="walletNode.pending.url">{{ hostOf(walletNode.pending.url) }}</div>
            </div>
          </div>
        </div>
        <p v-if="walletNode.pending.chainId !== 1" class="text-sm text-warn">Not Mainnet. Tokens here are test tokens.</p>
        <div class="grid grid-cols-2 gap-2">
          <button class="btn" @click="cancelWalletNode">Cancel</button>
          <button class="btn btn-plasma" data-testid="node-confirm" @click="confirmWalletNode">Use {{ zenonNetworkName(walletNode.pending.chainId) }}</button>
        </div>
      </div>
    </Modal>

    <Modal :open="evm.pickerOpen" title="Connect a wallet" @close="evm.pickerOpen = false">
      <div v-if="evm.wallets.length" class="grid gap-2">
        <button v-for="w in evm.wallets" :key="w.info.uuid" data-testid="wallet-option" class="btn !justify-start !h-14 text-base" @click="pick(w)">
          <img v-if="w.info.icon" :src="w.info.icon" width="28" height="28" alt="" class="rounded-md" />
          <Wallet v-else :size="22" />
          {{ w.info.name }}
        </button>
      </div>
      <p v-else class="text-soft">No EVM wallet found. Install MetaMask, Rabby or Phantom and reload.</p>
    </Modal>
  </div>
</template>

<style scoped>
.wallet.connected {
  --btn-line: color-mix(in srgb, var(--znn) 35%, var(--line-strong));
}
.node-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  font-size: 14px;
  color: var(--soft);
}
.node-switch:hover {
  color: var(--fg);
}
.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  width: min(300px, calc(100vw - 32px));
  padding: 14px;
  z-index: 40;
  box-shadow: var(--edge), var(--shadow-pop);
}
</style>
