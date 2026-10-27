import { expect, it } from 'vitest'
import { collectNativeFailureFacts, summarizeGoroutines, summarizeSyncLog } from '../../e2e/lab/native-diagnostics.mjs'

const profile=`goroutine 987654321 [semacquire]:
sync.(*Mutex).Lock(0x123, PRIVATE_ARGUMENT)
\t/Users/PRIVATE_PATH/source.go:12 +0x12
github.com/zenon-network/go-zenon/protocol/downloader.(*Downloader).process(0x987, PRIVATE_KEY)
\tPRIVATE_FILE.go:32 +0x32

`
const owner=()=>{
  const head='1'.repeat(40),tree='2'.repeat(40),build={key:'3'.repeat(64),binaryHash:'4'.repeat(64),sourceCommit:'5'.repeat(40),sourceTree:'6'.repeat(40)}
  const runtime={buildKey:build.key,znndHash:build.binaryHash,sourceCommit:build.sourceCommit,sourceTree:build.sourceTree,bridgeSourceCommit:head,bridgeSourceTree:tree,diagnostics:{profileHost:'127.0.0.1',profilePort:47210,rpcLogLevel:'error',coldCase:'error-a'}}
  return {head,tree,build,runtime}
}
it('retains only fixed sync categories and numeric heights from node logs',()=>{
  const result=summarizeSyncLog('msg="Block import failed" momentum-height=6 reason="won\'t insert side-chain which is not longer PRIVATE_PEER"\nmsg="common ancestor" number=2 peer-id=PRIVATE_KEY\nmsg="PRIVATE_OTHER" path=/Users/PRIVATE_PATH')
  expect(result).toMatchObject({counts:{IMPORT_FAILED:1,ANCESTOR_FOUND:1},events:[{kind:'IMPORT_FAILED',failedHeight:6,reason:'SIDE_CHAIN_NOT_LONGER'},{kind:'ANCESTOR_FOUND',ancestorHeight:2}]})
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|Users|peer-id/)
})
it('groups project goroutines without IDs, pointers, file paths or arguments',()=>{
  const result=summarizeGoroutines(profile+profile.replace('987654321','987654322'))
  expect(result).toMatchObject({status:'CAPTURED',observed:2,groups:[{state:'LOCK_WAIT',count:2,frames:['sync.(*Mutex).Lock','github.com/zenon-network/go-zenon/protocol/downloader.(*Downloader).process']}]})
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|987654|0x|Users|source.go/)
})
it('bounds incomplete or oversized diagnostic inputs instead of claiming full evidence',()=>{
  expect(()=>summarizeGoroutines('x'.repeat(2*1024*1024+1))).toThrow()
  expect(()=>summarizeSyncLog('x'.repeat(256*1024+1))).toThrow()
  expect(summarizeSyncLog('x'.repeat(4097)).truncated).toBe(true)
  expect(summarizeGoroutines('unavailable PRIVATE_VALUE').status).toBe('UNAVAILABLE')
  expect(summarizeGoroutines(profile.repeat(2050)).truncated).toBe(true)
})
it('never queries a profile or reads logs without the exact isolated runtime identity',async()=>{
  let reads=0
  const original=owner()
  for(const mutate of [(o:typeof original)=>{o.runtime.bridgeSourceCommit='7'.repeat(40)},(o:typeof original)=>{o.runtime.buildKey='7'.repeat(64)},(o:typeof original)=>{o.runtime.diagnostics.profileHost='private.fixture.invalid'},(o:typeof original)=>{o.runtime.diagnostics.profilePort=6060},(o:typeof original)=>{o.build.binaryHash=''}]){
    const changed=structuredClone(original);mutate(changed)
    const result=await collectNativeFailureFacts({...changed,readProfile:async()=>{reads++;return profile},readLogs:async()=>{reads++;return {}}})
    expect(result.status).toBe('OWNER_SCOPE_UNAVAILABLE')
  }
  expect(reads).toBe(0)
})
it('captures an owned runtime while excluding raw profile and query errors',async()=>{
  const result=await collectNativeFailureFacts({...owner(),readProfile:async()=>profile,readLogs:async()=>({rpc:summarizeSyncLog('msg="common ancestor" number=5 peer-id=PRIVATE_PEER')})})
  expect(result).toMatchObject({status:'CAPTURED',coldCase:'error-a',profile:{status:'CAPTURED'},logs:{rpc:{counts:{ANCESTOR_FOUND:1}}}})
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|0x|987654/)
  const unavailable=await collectNativeFailureFacts({...owner(),readProfile:async()=>{throw Error('PRIVATE_ENDPOINT')},readLogs:async()=>{throw Error('PRIVATE_PATH')}})
  expect(unavailable.status).toBe('PARTIAL');expect(JSON.stringify(unavailable)).not.toContain('PRIVATE')
})
it('supports unprofiled startup only with the exact postmortem owner fields',async()=>{
 const original=owner(),runtime={...original.runtime,diagnostics:{...original.runtime.diagnostics,profileMode:'postmortem',profileHost:null,profilePort:null}}
 const result=await collectNativeFailureFacts({...original,runtime,readProfile:async()=>profile,readLogs:async()=>({})})
 expect(result).toMatchObject({status:'CAPTURED',profileMode:'postmortem'})
 let reads=0
 const refused=await collectNativeFailureFacts({...original,runtime:{...runtime,diagnostics:{...runtime.diagnostics,profileHost:'127.0.0.1'}},readProfile:async()=>{reads++;return profile},readLogs:async()=>{reads++;return {}}})
 expect(refused.status).toBe('OWNER_SCOPE_UNAVAILABLE');expect(reads).toBe(0)
})
