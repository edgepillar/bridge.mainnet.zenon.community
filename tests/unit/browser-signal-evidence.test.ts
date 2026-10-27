import {expect,it} from 'vitest'
import {sanitizeSignalReport} from '../../e2e/lib/browser-signal-evidence.ts'
const sample=()=>({status:'COMPLETE',scope:'OWNED_INITIAL_NETWORK_SERVICE_INITIAL_THREADS',events:[{signal:'SIGKILL',senderRole:'OWNED_BROWSER',codeClass:'SI_USER',generationResult:'ACCEPTED'}],truncated:false,parseErrors:0,rawTracePublished:false,injectedSignals:0,targetOwnershipVerified:true,observedInitialThreads:6,kernelBufferLosses:0,stopReason:'TARGET_EXIT_OR_REPLACED',maximumWindowSeconds:15})
it('retains a generated signal category without claiming the initial IPC cause',()=>{
 expect(sanitizeSignalReport(sample()).events).toEqual(sample().events)
})
it('drops raw identifiers, paths, commands and arbitrary event fields',()=>{
 const r=sample();Object.assign(r,{pid:23,path:'/synthetic/private',command:'private'});Object.assign(r.events[0],{pid:24,comm:'private'})
 expect(JSON.stringify(sanitizeSignalReport(r))).not.toMatch(/private|comm|"pid"/)
})
it('refuses unowned, truncated, injected and lossy completion claims',()=>{
 for(const patch of [{targetOwnershipVerified:false},{truncated:true},{injectedSignals:1},{kernelBufferLosses:1},{parseErrors:1},{observedInitialThreads:0},{observedInitialThreads:65}])expect(()=>sanitizeSignalReport({...sample(),...patch})).toThrow()
})
it('refuses unbounded or peer-controlled categories',()=>{
 for(const patch of [{signal:'private'},{senderRole:'private'},{codeClass:'private'},{generationResult:'private'}])expect(()=>sanitizeSignalReport({...sample(),events:[{...sample().events[0],...patch}]})).toThrow()
 expect(()=>sanitizeSignalReport({...sample(),events:Array(65).fill(sample().events[0])})).toThrow()
})
