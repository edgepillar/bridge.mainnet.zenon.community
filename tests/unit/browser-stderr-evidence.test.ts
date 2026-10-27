import { expect, it } from 'vitest'
import { browserStderrEvidence } from '../../e2e/lib/browser-stderr-evidence.ts'

const line = '[987654:876543:1027/151443.325697:ERROR:content/browser/network_service_instance_impl.cc:653] Network service crashed or was terminated, restarting service.\n'

it('recognizes a pinned network-service restart message across stream boundaries', () => {
  const evidence = browserStderrEvidence()
  for (const chunk of [line.slice(0, 13), line.slice(13, 99), line.slice(99)]) evidence.ingest(chunk)
  expect(evidence.report().networkServiceRestarts).toBe(1)
  expect(evidence.report().partialLine).toBe(false)
})

it('accepts the alternate Chromium source-location format without retaining it', () => {
  const evidence = browserStderrEvidence()
  evidence.ingest(line.replace('content/browser/network_service_instance_impl.cc:653', 'network_service_instance_impl.cc(653)'))
  expect(evidence.report().networkServiceRestarts).toBe(1)
  expect(JSON.stringify(evidence.report())).not.toMatch(/987654|876543|network_service_instance_impl|151443/)
})

it('does not treat console text, unrelated errors or incomplete lines as a restart', () => {
  const evidence = browserStderrEvidence()
  evidence.ingest(line.replace('network_service_instance_impl.cc', 'CONSOLE'))
  evidence.ingest(line.replace('ERROR:', 'WARNING:'))
  evidence.ingest(line.trim())
  expect(evidence.report().networkServiceRestarts).toBe(0)
  expect(evidence.report().partialLine).toBe(true)
})

it('discards private lines and raw read errors from the report', () => {
  const evidence = browserStderrEvidence()
  evidence.ingest('PRIVATE_PATH PRIVATE_TOKEN PRIVATE_IDENTIFIER\n')
  evidence.captureReadError()
  evidence.ingest(line)
  expect(evidence.report().status).toBe('UNAVAILABLE')
  expect(evidence.report().networkServiceRestarts).toBe(0)
  expect(JSON.stringify(evidence.report())).not.toContain('PRIVATE')
})

it('refuses unbounded lines while still recognizing a later bounded line', () => {
  const evidence = browserStderrEvidence()
  evidence.ingest('x'.repeat(4097) + line + line)
  expect(evidence.report().overlongLines).toBe(1)
  expect(evidence.report().networkServiceRestarts).toBe(1)
})

it('stops inspecting bytes at the fixed cap and reports truncation honestly', () => {
  const evidence = browserStderrEvidence()
  evidence.ingest(Buffer.alloc(64 * 1024, 10))
  expect(evidence.report().truncated).toBe(false)
  evidence.ingest(line)
  evidence.ingest(line)
  expect(evidence.report().bytesInspected).toBe(64 * 1024)
  expect(evidence.report().truncated).toBe(true)
  expect(evidence.report().networkServiceRestarts).toBe(0)
})

it('uses a typed-array view byte range without inspecting its surrounding bytes', () => {
  const evidence = browserStderrEvidence(), bytes = Buffer.from('PRIVATE' + line + 'PRIVATE')
  evidence.ingest(new Uint8Array(bytes.buffer, bytes.byteOffset + 7, Buffer.byteLength(line)))
  expect(evidence.report().networkServiceRestarts).toBe(1)
  expect(evidence.report().bytesInspected).toBe(Buffer.byteLength(line))
  expect(JSON.stringify(evidence.report())).not.toContain('PRIVATE')
})

it('leaves missing browser stderr unavailable without fabricating a clean observation', () => {
  const evidence = browserStderrEvidence(false)
  evidence.ingest(line)
  expect(evidence.report().status).toBe('UNAVAILABLE')
  expect(evidence.report().bytesInspected).toBe(0)
})
