import { expect, it } from 'vitest'
import { browserTerminationEvidence } from '../../e2e/lib/browser-termination-evidence.ts'
const revision='@3ff7ac5a9224be9156d7f8703a06e22890aafd34'
const hist=(name:string,count:number,low=6)=>({name,buckets:[{low,high:low+1,count}]})

it('distinguishes utility crashes, kills and live disconnects from unrelated process buckets',async()=>{
 const values=[{histograms:[]},{histograms:[hist('ChildProcess.Crashed2',2),hist('ChildProcess.Killed2',1),hist('ChildProcess.DisconnectedAlive2',4),hist('PRIVATE_IGNORED',99)]}]
 const evidence=await browserTerminationEvidence(async()=>values.shift(),revision)
 evidence.markFailure();await evidence.captureAfterFailures()
 expect(evidence.report().delta).toEqual({crashed:2,killed:1,disconnectedAlive:4})
 expect(JSON.stringify(evidence.report())).not.toContain('PRIVATE')
 const other=await browserTerminationEvidence(async()=>({histograms:[hist('ChildProcess.Crashed2',20,9)]}),revision)
 expect(other.report().baseline).toEqual({status:'COMPLETE',counts:{crashed:0,killed:0,disconnectedAlive:0}})
})
it('performs no idle polling and captures one bounded pre-teardown summary',async()=>{
 let queries=0
 const evidence=await browserTerminationEvidence(async()=>{queries++;return {histograms:[]}},revision)
 await evidence.captureAfterFailures();expect(queries).toBe(1)
 for(let i=0;i<10;i++)evidence.markFailure()
 await Promise.all([evidence.captureAfterFailures(),evidence.captureAfterFailures()])
 expect(queries).toBe(2);expect(evidence.report().failedSockets).toBe(8);expect(evidence.report().truncated).toBe(true)
})
it('leaves missing, malformed, duplicate and unsupported-source evidence unavailable',async()=>{
 for(const value of [null,{histograms:'PRIVATE'}, {histograms:[null]}, {histograms:[hist('ChildProcess.Killed2',1),hist('ChildProcess.Killed2',1)]},{histograms:[hist('ChildProcess.Killed2',-1)]},{histograms:Array.from({length:129},()=>({}))}]){
  const evidence=await browserTerminationEvidence(async()=>value,revision)
  expect(evidence.report().baseline.status).toBe('UNAVAILABLE')
 }
 let calls=0
 const unavailable=await browserTerminationEvidence(async()=>{calls++;return {histograms:[]}},null)
 expect(calls).toBe(0);expect(unavailable.report().baseline.status).toBe('UNAVAILABLE')
})
it('does not infer a delta from failed, timed-out or decreasing counters',async()=>{
 const errors=await browserTerminationEvidence(async()=>{throw Error('PRIVATE_ERROR')},revision)
 errors.markFailure();await errors.captureAfterFailures()
 expect(errors.report().delta).toBeNull();expect(JSON.stringify(errors.report())).not.toContain('PRIVATE')
 const timeout=await browserTerminationEvidence(()=>new Promise(()=>{}),revision,1)
 expect(timeout.report().baseline).toEqual({status:'UNAVAILABLE',reason:'DEADLINE'})
 const values=[{histograms:[hist('ChildProcess.Crashed2',2)]},{histograms:[]}]
 const decrease=await browserTerminationEvidence(async()=>values.shift(),revision)
 decrease.markFailure();await decrease.captureAfterFailures();expect(decrease.report().delta).toBeNull()
})
