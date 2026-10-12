// The original's six disclaimer boxes, kept as one acknowledgement that is
// asked for once before the first transfer and remembered in this browser.
import { ref } from 'vue'

const KEY = 'bridge.terms.v1'
function read() {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}
export const accepted = ref(read())
export function accept() {
  accepted.value = true
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    /* holds for this tab */
  }
}

export const TERMS = [
  'I understand the risks of cryptocurrency and did my own research.',
  'This is experimental software, provided as is, with no guarantees.',
  'I will not use it for anything illegal.',
  'I am not a US person, not in or from an OFAC sanctioned country, and not visiting one.',
  'I will not send from a custodial wallet or directly to a contract.',
  'I understand I can lose funds permanently.',
]
