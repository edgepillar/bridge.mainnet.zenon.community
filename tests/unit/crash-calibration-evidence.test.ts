import {expect,it} from 'vitest'
import {calibrationFailureFacts} from '../../e2e/lib/browser-crash-evidence.mjs'
it('classifies protocol refusal without emitting the message',()=>{
 const report=calibrationFailureFacts(Object.assign(new Error('Protocol error (Page.crash): Page has pending navigations, not killing'),{code:-32000}))
 expect(report.category).toBe('PENDING_NAVIGATION');expect(report.protocolCode).toBe(-32000)
 expect(report).not.toHaveProperty('message')
})
it('keeps an arbitrary private failure out of structured diagnostics',()=>{
 const report=calibrationFailureFacts({message:'private@example.invalid /private/path token=synthetic',code:'private-value'})
 expect(report.category).toBe('UNCLASSIFIED');expect(report.protocolCode).toBeNull()
 expect(JSON.stringify(report)).not.toMatch(/example.invalid|private\/path|token=|private-value/)
})
it('bounds the selected error and records truncation explicitly',()=>{
 const report=calibrationFailureFacts({message:'x'.repeat(17000),code:1_000_001})
 expect(report.messageTruncated).toBe(true);expect(report.protocolCode).toBeNull();expect(report.messageSha256).toMatch(/^[a-f0-9]{64}$/)
})
it('handles absent and non-string error fields without decoding them',()=>{
 expect(calibrationFailureFacts(null).category).toBe('UNCLASSIFIED')
 expect(calibrationFailureFacts({message:{secret:'synthetic'}}).category).toBe('UNCLASSIFIED')
})
