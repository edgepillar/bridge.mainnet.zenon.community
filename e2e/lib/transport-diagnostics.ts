import { socketFailureClass } from './socket-evidence.ts'

const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)
const kinds = new Set(['URL_REQUEST', 'HTTP_STREAM_JOB_CONTROLLER', 'HTTP_STREAM_JOB', 'CONNECT_JOB', 'TCP_CONNECT_JOB_CONNECTOR', 'SOCKET'])
const errorEvents = new Set(['SOCKET_READ_ERROR', 'SOCKET_WRITE_ERROR', 'TCP_CONNECT', 'TCP_CONNECT_ATTEMPT', 'URL_REQUEST_START_JOB', 'HTTP_STREAM_JOB', 'HTTP_TRANSACTION_READ_HEADERS', 'WEBSOCKET_UPGRADE_FAILURE'])

// Raw NetLog can contain headers, URLs and payload metadata. Only numeric
// transport facts and fixed categories from the expected loopback graph leave
// this parser. Capture includes normal browser teardown, not just test failure.
export function summarizeNetLog(value: unknown, endpoint = 'ws://127.0.0.1:46998/') {
  if (!/^ws:\/\/127\.0\.0\.1:\d{1,5}\/$/.test(endpoint)) throw new Error('Isolated diagnostic endpoint required')
  const raw = object(value), constants = object(raw.constants)
  if (!Array.isArray(raw.events) || raw.events.length > 100_000) throw new Error('NetLog event bound or schema failed')
  const events = raw.events.map(object), names = new Map<number, string>(), types = new Map<number, string>()
  for (const [name, id] of Object.entries(object(constants.logEventTypes))) if (integer(id)) names.set(id, name)
  for (const [name, id] of Object.entries(object(constants.logSourceType))) if (integer(id)) types.set(id, name)
  if (!names.size || !types.size) throw new Error('NetLog constants unavailable')
  const key = (v: Record<string, any>) => integer(v.id) && integer(v.type) ? `${v.type}:${v.id}` : ''
  const roots: string[] = [], edges = new Map<string, Set<string>>()
  for (const event of events) {
    const source = object(event.source), params = object(event.params), dependency = object(params.source_dependency)
    const sourceKey = key(source), dependencyKey = key(dependency)
    if (types.get(source.type) === 'URL_REQUEST' && params.url === endpoint && !roots.includes(sourceKey)) roots.push(sourceKey)
    if (sourceKey && dependencyKey && kinds.has(types.get(source.type) ?? '') && kinds.has(types.get(dependency.type) ?? '')) {
      for (const [a, b] of [[sourceKey, dependencyKey], [dependencyKey, sourceKey]]) {
        if (!edges.has(a)) edges.set(a, new Set())
        edges.get(a)!.add(b)
      }
    }
  }
  if (roots.length > 16) throw new Error('NetLog connection bound exceeded')
  const connections = roots.map((root, connection) => {
    const graph = new Set([root]), queue = [root]
    for (let i = 0; i < queue.length; i++) for (const child of edges.get(queue[i]) ?? []) if (!graph.has(child)) {
      if (graph.size >= 128) throw new Error('NetLog source graph bound exceeded')
      graph.add(child); queue.push(child)
    }
    const errors: { event: string; code: number }[] = [], invalidFrames: { closeCode: number | null; failureClass: string }[] = []
    const lastReceivedFrames: Record<string, number | boolean>[] = []
    let receivedFrames = 0, closeTimeouts = 0, truncated = false
    for (const event of events) {
      if (!graph.has(key(object(event.source)))) continue
      const name = names.get(event.type), p = object(event.params)
      // -173 is the successful WebSocket upgrade, -3 normal cancellation.
      if (integer(p.net_error) && p.net_error < 0 && p.net_error >= -9999 && ![-173, -3].includes(p.net_error)) {
        if (errors.length < 16) errors.push({ event: errorEvents.has(name ?? '') ? name! : 'OTHER_TRANSPORT_EVENT', code: p.net_error })
        else truncated = true
      }
      if (name === 'WEBSOCKET_INVALID_FRAME') {
        if (invalidFrames.length < 8) invalidFrames.push({ closeCode: integer(p.code) ? p.code : null, failureClass: socketFailureClass(typeof p.internal_reason === 'string' ? p.internal_reason : '') })
        else truncated = true
      }
      if (name === 'WEBSOCKET_CLOSE_TIMEOUT') closeTimeouts++
      if (name === 'WEBSOCKET_RECV_FRAME_HEADER') {
        receivedFrames++
        const frame: Record<string, number | boolean> = {}
        for (const field of ['final', 'masked', 'reserved1', 'reserved2', 'reserved3']) if (typeof p[field] === 'boolean') frame[field] = p[field]
        for (const field of ['opcode', 'payload_length']) if (integer(p[field]) && p[field] >= 0) frame[field] = p[field]
        lastReceivedFrames.push(frame); if (lastReceivedFrames.length > 4) lastReceivedFrames.shift()
      }
    }
    return { connection, errors, invalidFrames, receivedFrames, lastReceivedFrames, closeTimeouts, truncated }
  })
  return { status: connections.length && !connections.some((c) => c.truncated) ? 'COMPLETE' : 'INCOMPLETE', includesBrowserTeardown: true, connections }
}

// These are the known isolated lab logs, never wallets or user node directories.
export function summarizeNativeLog(text: string) {
  if (text.length > 256 * 1024) throw new Error('Native diagnostic input bound exceeded')
  const panic = /panic:|fatal error:|invalid memory address/i.test(text)
  const categories = [['WRITE_TIMEOUT', /i\/o timeout|write.*timed out/i], ['CONNECTION_RESET', /connection reset by peer/i],
    ['BROKEN_PIPE', /broken pipe/i], ['PROCESS_EXIT', /A lab process exited/i], ['RPC_SHUTDOWN', /RPC server shutting down/i]] as const
  const frames: string[] = []
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^(github\.com\/zenon-network\/go-zenon\/[A-Za-z0-9_./-]+\.(?:\([*A-Za-z0-9_]+\)\.)?[A-Za-z0-9_.]+)/)
    if (match && frames.length < 24 && !frames.includes(match[1])) frames.push(match[1])
  }
  return { panic, categories: categories.filter(([, pattern]) => pattern.test(text)).map(([name]) => name), frames }
}
