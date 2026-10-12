import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { startNode, detectSyrius, node, syrius } from './state/zenon.ts'
import { evm, startEvmDiscovery } from './state/evm.ts'
import { bridge, startBridge } from './state/bridge.ts'
import { readReferralFromUrl } from './state/referral.ts'
import { activity, startActivity } from './state/activity.ts'

readReferralFromUrl()
void startNode().then(startBridge)
startEvmDiscovery()
void detectSyrius()
startActivity()

createApp(App).mount('#app')

// The live stores, for the headless checks and the e2e harness. Dev builds only.
if (import.meta.env.DEV) Object.assign(window, { __bridge: { bridge, node, syrius, evm, activity } })
