// Exact-height consensus checks for isolated lab diagnostics. No wallet data.
/** @param {unknown[]} samples @param {number} height */
export function agreesAtHeight(samples, height) {
  if (samples.length !== 5 || !Number.isSafeInteger(height) || height < 1) return false
  let hash
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') return false
    const m = sample
    if (m.chainIdentifier !== 322 || m.height !== height || typeof m.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(m.hash)) return false
    if (hash && hash.toLowerCase() !== m.hash.toLowerCase()) return false
    hash = m.hash
  }
  return true
}

/** Production alone does not make a freshly started lab ready for writes. */
export function readyAtFrontier(anchor, nodes) {
  if (!anchor || anchor.chainIdentifier !== 322 || !Number.isSafeInteger(anchor.height) || anchor.height < 20) return false
  if (nodes.length !== 5 || nodes.some((node) => !node || node.error || node.chainId !== 322 || !Number.isSafeInteger(node.height) || node.height < Math.max(20, anchor.height - 3))) return false
  return agreesAtHeight(nodes.map((node) => node.momentum), anchor.height - 3)
}

// Failure-only reads distinguish a missing peer set, sync lag and an early
// fork. Peer identities, addresses, names and raw errors never enter a report.
export async function readinessFailureDiagnostics(read, comparisonHeight = 2) {
  const ports = [46997, 47100, 47101, 47102, 47103]
  const natural = (n) => Number.isSafeInteger(n) && n >= 0
  if (!natural(comparisonHeight) || comparisonHeight < 1) throw new Error('Invalid diagnostic comparison height')
  const nodes = await Promise.all(ports.map(async (port) => {
    const unavailable = []
    const capture = async (label, method, params, validate) => {
      try { return validate(await read(port, method, params)) }
      catch { unavailable.push(label); return null }
    }
    const [peerCount, sync, earlyMomentum] = await Promise.all([
      capture('NETWORK_INFO', 'stats.networkInfo', [], (value) => {
        if (!natural(value?.numPeers)) throw new Error('Invalid peer count')
        return value.numPeers
      }),
      capture('SYNC_INFO', 'stats.syncInfo', [], (value) => {
        if (!natural(value?.state) || value.state > 3 || !natural(value?.currentHeight) || !natural(value?.targetHeight)) throw new Error('Invalid sync state')
        return { state: value.state, currentHeight: value.currentHeight, targetHeight: value.targetHeight }
      }),
      capture('EARLY_MOMENTUM', 'ledger.getMomentumsByHeight', [2, 1], (value) => {
        const m = value?.list?.[0]
        if (m?.chainIdentifier !== 322 || m.height !== 2 || typeof m.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(m.hash)) throw new Error('Invalid early momentum')
        return { height: 2, chainIdentifier: 322, hash: m.hash.toLowerCase() }
      }),
    ])
    const commonMomentum = comparisonHeight === 2 ? earlyMomentum : await capture('COMMON_MOMENTUM', 'ledger.getMomentumsByHeight', [comparisonHeight, 1], (value) => {
      const m = value?.list?.[0]
      if (m?.chainIdentifier !== 322 || m.height !== comparisonHeight || typeof m.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(m.hash)) throw new Error('Invalid common momentum')
      return { height: m.height, chainIdentifier: 322, hash: m.hash.toLowerCase() }
    })
    return { port, peerCount, sync, earlyMomentum, commonMomentum, unavailable: unavailable.sort() }
  }))
  const early = nodes.map((n) => n.earlyMomentum)
  return { schema: 1, scope: 'FAILURE_ONLY_READ_ONLY', status: nodes.some((n) => n.unavailable.length) ? 'PARTIAL' : 'COMPLETE',
    earlyHeight: 2, earlyHashesAgree: early.some((m) => !m) ? null : agreesAtHeight(early, 2),
    comparisonHeight, commonHashesAgree: nodes.some((n) => !n.commonMomentum) ? null : agreesAtHeight(nodes.map((n) => n.commonMomentum), comparisonHeight), nodes }
}
