import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { attachOwnedPostmortem, identityForPostmortem, ownedPostmortemController, requestOwnedPostmortem } from '../../e2e/lab/native-postmortem.mjs'
import { summarizeGoroutines } from '../../e2e/lab/native-diagnostics.mjs'

const identity=()=>identityForPostmortem({head:'1'.repeat(40),tree:'2'.repeat(40),build:{key:'3'.repeat(64),binaryHash:'4'.repeat(64),sourceCommit:'5'.repeat(40),sourceTree:'6'.repeat(40)}})
const challenge='00000000-1111-2222-3333-444444444444'
const request=()=>({kind:'GOROUTINE_POSTMORTEM',identity:identity(),challenge})
const cleanups:Array<()=>void>=[]
afterEach(()=>{for(const f of cleanups.splice(0).reverse())f()})
const temp=()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'owned-postmortem-test-'));cleanups.push(()=>fs.rmSync(d,{recursive:true,force:true}));return d}

it('rejects foreign source, challenge, kind, PID fields and oversized requests before signaling',()=>{
 let signals=0
 const control=ownedPostmortemController({identity:identity(),challenge,signalRpc:()=>{signals++;return true}})
 const good=request()
 for(const value of [{...good,challenge:'00000000-1111-2222-3333-555555555555'},{...good,identity:{...good.identity,head:'7'.repeat(40)}},{...good,kind:'OTHER'},{...good,pid:987654321},{...good,identity:{...good.identity,binaryHash:['4'.repeat(64)]}}])expect(control.accept(JSON.stringify(value))).toBe(false)
 expect(control.accept('x'.repeat(4097))).toBe(false);expect(control.accept('{')).toBe(false)
 expect(signals).toBe(0);expect(control.exited(2,null)).toBeNull()
})
it('permits one exact owned callback and refuses replay even after its child exits',()=>{
 let signals=0
 const control=ownedPostmortemController({identity:identity(),challenge,signalRpc:()=>{signals++;return true}})
 expect(control.accept(JSON.stringify(request()))).toBe(true)
 expect(control.exited(2,null)).toMatchObject({status:'EXITED',code:2,signal:null})
 expect(control.accept(JSON.stringify(request()))).toBe(false);expect(signals).toBe(1)
})
it('captures private stderr only after the exact owned exit and strips SIGQUIT metadata',async()=>{
 const directory=temp();let signals=0
 const raw='SIGQUIT: quit\n\ngoroutine 987654321 gp=0x123 m=0 mp=0x456 [chan receive]:\ngithub.com/zenon-network/go-zenon/protocol.(*ProtocolManager).syncer(0x123, PRIVATE_ARGUMENT)\n\tPRIVATE_FILE.go:12 +0x12\n\n'
 const owner=await attachOwnedPostmortem({directory,identity:identity(),signalRpc:()=>{signals++;setTimeout(()=>{fs.writeFileSync(path.join(directory,'rpc.log'),raw,{mode:0o600});owner.noteExit(2,null);owner.close()},0);return true}})
 cleanups.push(()=>owner.close())
 const captured=await requestOwnedPostmortem({directory,identity:identity()})
 expect(captured).toBe(raw);expect(signals).toBe(1)
 const summary=summarizeGoroutines(captured)
 expect(summary).toMatchObject({status:'CAPTURED',observed:1,groups:[{state:'CHANNEL_RECEIVE',count:1}]})
 expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|987654|0x|gp=|mp=/)
 for(const n of ['diagnostic-owner.private.json','diagnostic-request.private.json','diagnostic-result.private.json'])expect(fs.statSync(path.join(directory,n)).mode&0o777).toBe(0o600)
})
it('refuses changed source before creating a request or calling the owner',async()=>{
 const directory=temp();let signals=0
 const owner=await attachOwnedPostmortem({directory,identity:identity(),signalRpc:()=>{signals++;return true}});cleanups.push(()=>owner.close())
 await expect(requestOwnedPostmortem({directory,identity:{...identity(),tree:'7'.repeat(40)}})).rejects.toThrow('identity changed')
 expect(signals).toBe(0);expect(fs.existsSync(path.join(directory,'diagnostic-request.private.json'))).toBe(false)
})
it('preserves a dangling owner link instead of replacing unrelated evidence',async()=>{
 const directory=temp(),file=path.join(directory,'diagnostic-owner.private.json');fs.symlinkSync('missing-owned-fixture',file)
 await expect(attachOwnedPostmortem({directory,identity:identity(),signalRpc:()=>true})).rejects.toThrow('must be preserved')
 expect(fs.lstatSync(file).isSymbolicLink()).toBe(true)
})
it('rejects a broadly readable owner record without signaling',async()=>{
 const directory=temp();let signals=0
 const owner=await attachOwnedPostmortem({directory,identity:identity(),signalRpc:()=>{signals++;return true}});cleanups.push(()=>owner.close())
 fs.chmodSync(path.join(directory,'diagnostic-owner.private.json'),0o644)
 await expect(requestOwnedPostmortem({directory,identity:identity()})).rejects.toThrow('unavailable');expect(signals).toBe(0)
})
it('does not treat a normal exit as a completed postmortem or return raw private stderr',async()=>{
 const directory=temp()
 const owner=await attachOwnedPostmortem({directory,identity:identity(),signalRpc:()=>{setTimeout(()=>{fs.writeFileSync(path.join(directory,'rpc.log'),'PRIVATE_RAW_VALUE');owner.noteExit(0,null)},0);return true}});cleanups.push(()=>owner.close())
 await expect(requestOwnedPostmortem({directory,identity:identity()})).rejects.toThrow('owned exit unavailable')
})
it('bounds missing acknowledgements without retrying the owned signal',async()=>{
 const directory=temp();let signals=0
 const owner=await attachOwnedPostmortem({directory,identity:identity(),signalRpc:()=>{signals++;return true}});cleanups.push(()=>owner.close())
 await expect(requestOwnedPostmortem({directory,identity:identity(),timeoutMs:100})).rejects.toThrow('deadline exceeded');expect(signals).toBe(1)
 await expect(requestOwnedPostmortem({directory,identity:identity(),timeoutMs:100})).rejects.toThrow('must be preserved');expect(signals).toBe(1)
})
it('refuses oversized raw stderr before allocating or returning a capture',async()=>{
 const directory=temp()
 const owner=await attachOwnedPostmortem({directory,identity:identity(),signalRpc:()=>{setTimeout(()=>{fs.writeFileSync(path.join(directory,'rpc.log'),Buffer.alloc(2*1024*1024+1));owner.noteExit(2,null)},0);return true}});cleanups.push(()=>owner.close())
 await expect(requestOwnedPostmortem({directory,identity:identity()})).rejects.toThrow('file unavailable')
})
