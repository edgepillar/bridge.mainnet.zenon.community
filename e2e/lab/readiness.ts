// Exact-height consensus checks for isolated lab diagnostics. No wallet data.
export function agreesAtHeight(samples: unknown[], height: number): boolean {
  if (samples.length !== 5 || !Number.isSafeInteger(height) || height < 1) return false
  let hash: string | undefined
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') return false
    const m = sample as { chainIdentifier?: unknown; height?: unknown; hash?: unknown }
    if (m.chainIdentifier !== 322 || m.height !== height || typeof m.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(m.hash)) return false
    if (hash && hash.toLowerCase() !== m.hash.toLowerCase()) return false
    hash = m.hash
  }
  return true
}
