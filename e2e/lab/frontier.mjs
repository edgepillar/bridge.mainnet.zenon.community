#!/usr/bin/env node
// Is the lab producing? Reads the frontier momentum, then again every five
// seconds until the height has moved or the time is up.
//
//   node frontier.mjs [seconds to give it, default 30] [--wait <seconds>]
//
// A chain that has stopped still answers, so one read proves nothing. `--wait`
// keeps trying until the node answers at all, for the minutes after `up`.
// Exit status 0 only when the height moved. After syrius-extension's lab.
const args = process.argv.slice(2)
const waitAt = args.indexOf('--wait')
const wait = waitAt >= 0 ? Number(args.splice(waitAt, 2)[1]) : 0
const patience = Number(args[0] || 30)
const url = process.env.LAB_RPC || 'http://127.0.0.1:46997'

async function frontier() {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ledger.getFrontierMomentum', params: [] }),
    signal: AbortSignal.timeout(5000),
  })
  const reply = await res.json()
  if (reply.error) throw new Error(reply.error.message)
  return reply.result
}
const pause = (s) => new Promise((r) => setTimeout(r, s * 1000))

const deadline = Date.now() + wait * 1000
let first
for (;;) {
  try {
    first = await frontier()
    break
  } catch (error) {
    if (Date.now() >= deadline) {
      console.error(`${url}: ${error.message}`)
      process.exit(1)
    }
    await pause(3)
  }
}
const started = Date.now()
let second = first
while (second.height === first.height && Date.now() - started < patience * 1000) {
  await pause(5)
  second = await frontier().catch(() => second)
}
const moved = second.height - first.height
console.log(`chain ${second.chainIdentifier}: ${first.height} then ${second.height} after ${Math.round((Date.now() - started) / 1000)} s`)
console.log(moved > 0 ? 'producing' : 'NOT producing')
process.exit(moved > 0 ? 0 : 1)
