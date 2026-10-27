import { expect, it } from 'vitest'
import { collectNativeFailureFacts, nativeFailureTarget, summarizeGoroutines, summarizeSyncLog } from '../../e2e/lab/native-diagnostics.mjs'

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
it('distinguishes the pinned hash-completion handoff from the active hash-reply select',()=>{
 const hashWait=(line:number)=>`goroutine 987654321 [select]:\ngithub.com/zenon-network/go-zenon/protocol/downloader.(*Downloader).fetchHashes(PRIVATE_ARGUMENT)\n\t/PRIVATE_SOURCE/protocol/downloader/downloader.go:${line} +0x123\n\n`
 const commit='616f0a61ebc8562846965822f94976e531e0937c'
 const result=summarizeGoroutines(hashWait(548)+hashWait(532),commit)
 expect(result.groups.map((g:any)=>g.waitSite)).toEqual(['HASH_COMPLETION_HANDOFF','HASH_REPLY_OR_TIMEOUT'])
 expect(JSON.stringify(result)).not.toMatch(/PRIVATE|987654|0x123|downloader\.go|548|532/)
 expect(summarizeGoroutines(hashWait(548)).groups[0]).not.toHaveProperty('waitSite')
 expect(summarizeGoroutines(hashWait(548),'7'.repeat(40)).groups[0]).not.toHaveProperty('waitSite')
 expect(summarizeGoroutines(hashWait(549),commit).groups[0]).not.toHaveProperty('waitSite')
})
it('keeps the two real sync-worker joins distinct without publishing source paths',()=>{
 const join=(line:number)=>`goroutine 987654321 [chan receive]:\ngithub.com/zenon-network/go-zenon/protocol/downloader.(*Downloader).syncWithPeer(PRIVATE_ARGUMENT)\n\t/PRIVATE_SOURCE/protocol/downloader/downloader.go:${line} +0x123\n\n`
 const result=summarizeGoroutines(join(330)+join(336),'616f0a61ebc8562846965822f94976e531e0937c')
 expect(result.groups.map((g:any)=>g.waitSite)).toEqual(['SYNC_JOIN_FIRST_WORKER','SYNC_JOIN_AFTER_FIRST_SUCCESS'])
 expect(JSON.stringify(result)).not.toMatch(/PRIVATE|987654|0x123|downloader\.go|330|336/)
})
it('requires the exact built downloader file hash before inferring a source wait site',async()=>{
 const original=owner(),commit='616f0a61ebc8562846965822f94976e531e0937c'
 for(const fileHash of [undefined,'7'.repeat(64),'2f5b1adf15958ba170d288831225b9a4156d57c9348676b321fbb755f2aaaa68','1a4ab891c4ced859adc249853f48f893a63ddfd90f886d2b6a6306c649e8d8b8']){
  const stack=`goroutine 987654321 [select]:\ngithub.com/zenon-network/go-zenon/protocol/downloader.(*Downloader).fetchHashes(PRIVATE_ARGUMENT)\n\t/PRIVATE_SOURCE/protocol/downloader/downloader.go:${fileHash?.startsWith('1a4a')?550:548} +0x123\n\n`
  const build={...original.build,sourceCommit:commit,downloaderSourceHash:fileHash}
  const runtime={...original.runtime,sourceCommit:commit}
  const result=await collectNativeFailureFacts({...original,build,runtime,readProfile:async()=>stack,readLogs:async()=>({})})
  expect(result.profile.groups[0].waitSite).toBe(fileHash?.startsWith('2f5b')||fileHash?.startsWith('1a4a')?'HASH_COMPLETION_HANDOFF':undefined)
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|987654|0x123|downloader\.go/)
 }
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
const frontiers=()=>[46997,47100,47101,47102,47103].map(port=>({port,height:41,chainId:322,error:null}))
it('selects the actual lagging RPC or producer in the preserved failure shapes',()=>{
 for(const [port,height,nodeRole] of [[46997,5,'rpc'],[47100,2,'pillar'],[47101,3,'pillar2']] as const){
  const nodes=frontiers();nodes.find(n=>n.port===port)!.height=height
  expect(nativeFailureTarget(nodes)).toEqual({nodeRole,port,frontierHeight:height})
 }
})
it('refuses malformed, duplicate, missing and foreign frontier ownership before selecting a target',()=>{
 const original=frontiers()
 for(const nodes of [null,original.slice(1),[...original.slice(0,4),original[0]],original.map((n,i)=>i===0?{...n,port:6060}:n),original.map((n,i)=>i===0?{...n,chainId:1}:n),original.map((n,i)=>i===0?{...n,height:'3'}:n),original.map((n,i)=>i===0?{...n,error:'READ_UNAVAILABLE'}:n)])expect(nativeFailureTarget(nodes)).toBeNull()
})
it('uses a deterministic owned producer when several frontiers share the minimum',()=>{
 const nodes=frontiers();nodes.find(n=>n.port===46997)!.height=3;nodes.find(n=>n.port===47100)!.height=3
 expect(nativeFailureTarget(nodes.reverse())).toEqual({nodeRole:'pillar',port:47100,frontierHeight:3})
})
it('requires all declared owned node roles before collecting a non-RPC postmortem',async()=>{
 const original=owner(),roles=['rpc','pillar','pillar2','pillar3','observer'];let reads=0
 const readProfile=async()=>{reads++;return profile},readLogs=async()=>({})
 for(const declared of [undefined,['pillar2'],['rpc','pillar','pillar2','pillar3','pillar2']]){
  const result=await collectNativeFailureFacts({...original,nodeRole:'pillar2',runtime:{...original.runtime,diagnostics:{...original.runtime.diagnostics,postmortemRoles:declared}},readProfile,readLogs})
  expect(result.status).toBe('OWNER_SCOPE_UNAVAILABLE')
 }
 expect(reads).toBe(0)
 const result=await collectNativeFailureFacts({...original,nodeRole:'pillar2',runtime:{...original.runtime,diagnostics:{...original.runtime.diagnostics,postmortemRoles:roles}},readProfile,readLogs})
 expect(result).toMatchObject({status:'CAPTURED',nodeRole:'pillar2',profileMode:'loopback',captureMode:'postmortem'});expect(reads).toBe(1)
 expect(JSON.stringify(result)).not.toMatch(/PRIVATE|0x|987654/)
})
