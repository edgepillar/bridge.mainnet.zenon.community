import {afterEach,expect,it,vi} from 'vitest'
import {probeLedgerRound} from '../../e2e/lib/probe-ledger-round.mjs'

afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
const momentum={chainIdentifier:322,height:40,hash:'0'.repeat(64)}
function socketFixture(frontier:unknown,rows:unknown={list:[momentum]}){
 const sent:any[]=[],instances:any[]=[]
 class Socket{
  static OPEN=1;readyState=1;onopen?:()=>void;onmessage?:(value:unknown)=>void;onclose?:()=>void
  constructor(){instances.push(this);Promise.resolve().then(()=>this.onopen?.())}
  send(data:string){const request=JSON.parse(data);sent.push(request);Promise.resolve().then(()=>this.onmessage?.({data:JSON.stringify({jsonrpc:'2.0',id:request.id,result:request.id===1?frontier:rows})}))}
  close(){this.readyState=3;this.onclose?.()}
 }
 vi.stubGlobal('WebSocket',Socket)
 return {sent,instances}
}
it('waits for a validated frontier before the twelve bounded recent-momentum reads',async()=>{
 vi.useFakeTimers();const fixture=socketFixture(momentum),result=probeLedgerRound('ws://127.0.0.1:46998/')
 await vi.advanceTimersByTimeAsync(750)
 expect(await result).toEqual({received:13,errors:0,invalid:0,open:true,frontierHeight:40})
 expect(fixture.sent[0]).toEqual({jsonrpc:'2.0',id:1,method:'ledger.getFrontierMomentum',params:[]})
 expect(fixture.sent.slice(1)).toHaveLength(12)
 expect(fixture.sent.slice(1).every(x=>x.method==='ledger.getMomentumsByPage'&&JSON.stringify(x.params)==='[0,30]')).toBe(true)
})
it('does not release subsequent reads after a wrong-chain frontier',async()=>{
 const fixture=socketFixture({...momentum,chainIdentifier:1})
 expect((await probeLedgerRound('ws://127.0.0.1:46998/')).invalid).toBe(1)
 expect(fixture.sent).toHaveLength(1)
})
it('refuses malformed momentum lists without accepting partial completion',async()=>{
 const fixture=socketFixture(momentum,{list:[{...momentum,hash:'invalid'}]})
 const result=await probeLedgerRound('ws://127.0.0.1:46998/')
 expect(result.received).toBe(1);expect(result.invalid).toBe(1);expect(fixture.instances[0].readyState).toBe(3)
})
it('refuses non-loopback, credential-bearing and unexpected endpoints before opening a socket',async()=>{
 const fixture=socketFixture(momentum)
 for(const endpoint of ['wss://remote.example/','ws://user@127.0.0.1:46998/','ws://127.0.0.1:46998/path','ws://127.0.0.1:46998/?private=1'])expect((await probeLedgerRound(endpoint)).invalid).toBe(1)
 expect(fixture.instances).toHaveLength(0)
})
