// The referral in effect for this browser, from ?referral= or an earlier
// visit. Shown in a banner with a Clear button wherever it applies.
import { ref } from 'vue'
import { applyReferral, localReferralStore, referrerFromCode } from '../core/referral.ts'

export const referrer = ref<string | null>(referrerFromCode(localReferralStore.get()))
/** Set when this page load carried a referral link. */
export const arrivedWithReferral = ref(false)

export function readReferralFromUrl() {
  const params = new URLSearchParams(location.search)
  const code = params.get('referral')
  if (!code) return
  arrivedWithReferral.value = true
  referrer.value = applyReferral(code)
}

export function clearReferral() {
  localReferralStore.clear()
  referrer.value = null
  // Drop it from the address bar too, so a reload does not apply it again.
  const url = new URL(location.href)
  if (url.searchParams.has('referral')) {
    url.searchParams.delete('referral')
    history.replaceState(null, '', url.toString())
  }
}
