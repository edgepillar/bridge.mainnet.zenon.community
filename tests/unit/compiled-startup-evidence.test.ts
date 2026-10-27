import {expect,it} from 'vitest'
import {compiledStartupEvidence} from '../../e2e/lib/compiled-startup-evidence.mjs'
const request=JSON.stringify({jsonrpc:'2.0',id:1,method:'ledger.getFrontierMomentum',params:[]})
const response=(chain=322)=>JSON.stringify({jsonrpc:'2.0',id:1,result:{chainIdentifier:chain,height:40,hash:'0'.repeat(64)}})
function valid(e:ReturnType<typeof compiledStartupEvidence>,id='owned'){
 e.created(id,'ws://127.0.0.1:46998/');e.handshake(id,101);e.sent(id,request);e.received(id,response())
}
it('requires an owned handshake and a paired validated frontier',()=>{
 const e=compiledStartupEvidence();valid(e);expect(e.report()).toEqual({received:1,errors:0,invalid:0,open:true,frontierHeight:40,socketCount:1})
})
it('cannot validate an unsolicited or replayed response',()=>{
 const e=compiledStartupEvidence();e.created('owned','ws://127.0.0.1:46998/');e.handshake('owned',101);e.received('owned',response());expect(e.report().received).toBe(0)
 e.sent('owned',request);e.received('owned',response());e.received('owned',response(1));expect(e.report().invalid).toBe(0);expect(e.report().received).toBe(1)
})
it('rejects a paired frontier from another chain',()=>{
 const e=compiledStartupEvidence();e.created('owned','ws://127.0.0.1:46998/');e.handshake('owned',101);e.sent('owned',request);e.received('owned',response(1));expect(e.report().invalid).toBe(1);expect(e.report().open).toBe(false)
})
it('keeps the first socket failure fatal when a replacement becomes valid',()=>{
 const e=compiledStartupEvidence();valid(e);e.failed('owned');e.closed('owned');valid(e,'replacement');expect(e.report().open).toBe(true);expect(e.report().errors).toBe(1)
})
it('refuses another endpoint and a failed handshake',()=>{
 const e=compiledStartupEvidence();e.created('external','wss://synthetic.invalid/');e.handshake('external',101);e.sent('external',request);e.received('external',response());expect(e.report().open).toBe(false);expect(e.report().errors).toBe(1)
 const f=compiledStartupEvidence();valid(f);f.handshake('owned',403);expect(f.report().open).toBe(false);expect(f.report().errors).toBe(1)
})
it('bounds socket and pending evidence and excludes identifiers or bodies',()=>{
 const e=compiledStartupEvidence();valid(e,'synthetic-private-id')
 for(let i=2;i<19;i++)e.sent('synthetic-private-id',JSON.stringify({id:i,method:'ledger.getFrontierMomentum'}))
 expect(e.report().invalid).toBe(1)
 for(let i=0;i<9;i++)e.created('extra'+i,'ws://127.0.0.1:46998/')
 expect(e.report().socketCount).toBe(8);expect(e.report().invalid).toBeGreaterThan(1)
 expect(JSON.stringify(e.report())).not.toMatch(/synthetic-private|hash|jsonrpc|\/\//)
})
