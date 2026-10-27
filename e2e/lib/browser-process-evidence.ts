// Keep process identifiers only in this closure. Published diagnostics retain
// counts and set comparisons, never identifiers, command lines or raw errors.
type ProcessSet = { status: 'COMPLETE'; ids: Set<number> } | { status: 'UNAVAILABLE'; reason: 'QUERY_FAILED' | 'DEADLINE' | 'INVALID_SCHEMA' }
type Sample = { status: 'COMPLETE'; networkServices: number } | { status: 'UNAVAILABLE'; reason: string }
const summary = (value: ProcessSet): Sample => value.status === 'COMPLETE'
  ? { status: 'COMPLETE', networkServices: value.ids.size }
  : { status: 'UNAVAILABLE', reason: value.reason }

export async function browserProcessEvidence(query: () => Promise<unknown>, timeoutMs = 2000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000) throw new Error('Invalid diagnostic deadline')
  const read = async (): Promise<ProcessSet> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        query().then(value => ({ value }), () => ({ failure: 'QUERY_FAILED' as const })),
        new Promise<{ failure: 'DEADLINE' }>(resolve => { timer = setTimeout(() => resolve({ failure: 'DEADLINE' }), timeoutMs) }),
      ])
      if ('failure' in result) return { status: 'UNAVAILABLE', reason: result.failure }
      const rows = (result.value as { processInfo?: unknown } | null)?.processInfo
      if (!Array.isArray(rows) || rows.length > 64) return { status: 'UNAVAILABLE', reason: 'INVALID_SCHEMA' }
      const ids = new Set<number>()
      for (const row of rows) if (row?.type === 'network.mojom.NetworkService') {
        if (!Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id)) return { status: 'UNAVAILABLE', reason: 'INVALID_SCHEMA' }
        ids.add(row.id)
      }
      return { status: 'COMPLETE', ids }
    } catch {
      return { status: 'UNAVAILABLE', reason: 'QUERY_FAILED' }
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }
  const baseline = await read()
  const failures: { sample: Sample; networkServiceChanged: boolean | null }[] = []
  let truncated = false
  return {
    async captureFailure() {
      if (failures.length >= 8) { truncated = true; return }
      const record: typeof failures[number] = { sample: { status: 'UNAVAILABLE', reason: 'PENDING' }, networkServiceChanged: null }
      failures.push(record)
      const current = await read()
      record.sample = summary(current)
      if (baseline.status === 'COMPLETE' && baseline.ids.size > 0 && current.status === 'COMPLETE') {
        record.networkServiceChanged = baseline.ids.size !== current.ids.size || [...baseline.ids].some(id => !current.ids.has(id))
      }
    },
    report: () => ({ mode: 'FAILURE_TRIGGERED' as const, baseline: summary(baseline), failures, truncated }),
  }
}
