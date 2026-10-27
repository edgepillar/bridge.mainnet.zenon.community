import {expect,it} from 'vitest'
import {browserMemoryEvidence} from '../../e2e/lib/browser-memory-evidence.ts'

it('captures bounded hierarchical memory deltas once without process attribution',()=>{
 let calls=0
 const values=['low 0\nhigh 1\nmax 2\noom 3\noom_kill 4\noom_group_kill 0\n','low 0\nhigh 2\nmax 3\noom 4\noom_kill 5\noom_group_kill 0\n']
 const e=browserMemoryEvidence(()=>{calls++;return values.shift()!})
 expect(calls).toBe(1);expect(e.report().sample).toBeNull()
 e.captureAfterFailure();e.captureAfterFailure()
 expect(calls).toBe(2);expect(e.report().delta).toEqual({low:0,high:1,max:1,oom:1,oom_kill:1,oom_group_kill:0})
 expect(e.report().attribution).toBe('NOT_PROCESS_SPECIFIC')
})
it('leaves missing or malformed memory evidence unavailable',()=>{
 for(const value of ['', 'oom 1\n', 'oom 1\noom_kill -1\n','oom 1\noom_kill 2\noom 3\n','oom 9007199254740992\noom_kill 0\n','x'.repeat(4097)]){
  expect(browserMemoryEvidence(()=>value).report().baseline.status).toBe('UNAVAILABLE')
 }
})
it('discards raw memory errors and unknown private field names',()=>{
 const e=browserMemoryEvidence(()=>{throw Error('PRIVATE_PATH PRIVATE_IDENTIFIER')})
 e.captureAfterFailure();expect(e.report().delta).toBeNull();expect(JSON.stringify(e.report())).not.toContain('PRIVATE')
 const clean=browserMemoryEvidence(()=>'private_field 9\noom 0\noom_kill 0\n')
 expect(clean.report().baseline).toEqual({status:'COMPLETE',counts:{oom:0,oom_kill:0}})
 expect(JSON.stringify(clean.report())).not.toContain('private_field')
})
it('does not infer a delta from decreasing or unavailable counters',()=>{
 const values=['oom 2\noom_kill 1\n','oom 1\noom_kill 1\n']
 const e=browserMemoryEvidence(()=>values.shift()!);e.captureAfterFailure();expect(e.report().delta).toBeNull()
 const other=browserMemoryEvidence(()=>{throw Error('unavailable')});other.captureAfterFailure();expect(other.report().delta).toBeNull()
})
