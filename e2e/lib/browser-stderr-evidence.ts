// Inspect only bounded stderr from the browser owned by this fixture. Publish
// fixed counters, never raw lines, process identifiers, paths or error objects.
export function browserStderrEvidence(available = true) {
  const byteLimit = 64 * 1024, lineLimit = 4096
  let bytesInspected = 0, truncated = false, overlongLines = 0, networkServiceRestarts = 0
  let fatalMessages=0,mojoErrorMessages=0,outOfMemoryMessages=0,websocketFrameVectorChecks=0
  const signalNumbers={'4':0,'5':0,'6':0,'7':0,'10':0,'11':0,'12':0,'31':0}
  let pending = '', discardingLine = false, readError = false
  const inspectLine = () => {
    // The pinned Chromium source emits this message when a previously bound
    // network service is recreated. It does not distinguish crash from kill.
    if (/^\[[^\]\r\n]{1,160}:ERROR:(?:content\/browser\/)?network_service_instance_impl\.cc(?:\(\d+\)|:\d+)\] Network service crashed or was terminated, restarting service\.$/.test(pending)) networkServiceRestarts++
    if(/^\[[^\]\r\n]{1,160}:FATAL:[^\]\r\n]{1,200}\]/.test(pending)){
      fatalMessages++
      if(/\bOut of memory\b/i.test(pending))outOfMemoryMessages++
      // Pinned WebSocketBasicStream rejects stale frame-vector contents here.
      if(/websocket_basic_stream\.cc(?:\(\d+\)|:\d+)\] Check failed: frames->empty\(\)/.test(pending))websocketFrameVectorChecks++
    }
    if(/^\[[^\]\r\n]{1,160}:WARNING:(?:services\/network\/)?network_service\.cc(?:\(\d+\)|:\d+)\] Mojo error in NetworkService:/.test(pending))mojoErrorMessages++
    const signal=/^Received signal (4|5|6|7|10|11|12|31)(?:\s|$)/.exec(pending)
    if(signal)signalNumbers[signal[1] as keyof typeof signalNumbers]++
    pending = ''
  }
  return {
    ingest(chunk: Uint8Array | string) {
      if (!available || readError || truncated) return
      const remaining = byteLimit - bytesInspected
      const input = typeof chunk === 'string' ? Buffer.from(chunk.slice(0, remaining + 1)) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      const count = Math.min(input.length, remaining)
      bytesInspected += count
      for (const byte of input.subarray(0, count)) {
        if (byte === 10) {
          if (!discardingLine) inspectLine()
          pending = ''; discardingLine = false
        } else if (!discardingLine) {
          if (pending.length === lineLimit) { overlongLines++; pending = ''; discardingLine = true }
          else pending += String.fromCharCode(byte)
        }
      }
      if (input.length > remaining) { truncated = true; pending = '' }
    },
    captureReadError() { readError = true; pending = '' },
    report: () => ({
      status: available && !readError ? 'CAPTURED' as const : 'UNAVAILABLE' as const,
      scope: 'POST_LAUNCH_PRE_TEARDOWN' as const, byteLimit, bytesInspected, truncated,
      overlongLines, partialLine: pending.length > 0 || discardingLine, networkServiceRestarts,
      fatalMessages,mojoErrorMessages,outOfMemoryMessages,websocketFrameVectorChecks,signalNumbers:{...signalNumbers},
    }),
  }
}
