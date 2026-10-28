// Pair only the initial compiled client's owned frontier replies. RPC bodies,
// request IDs and hashes stay inside this closure and never enter the report.
export function compiledScriptPath(name){
 if(typeof name!=='string'||!(name==='/theme-init.js'||/^\/assets\/[A-Za-z0-9_.-]+\.js$/.test(name)))throw Error('Compiled script name refused')
 return name.slice(1)
}

export function compiledStartupEvidence(){
 const sockets=new Map();let malformed=0,unexpected=0
 const parse=raw=>{if(typeof raw!=='string'||raw.length>65536)return null;try{return JSON.parse(raw)}catch{return null}}
 return {
  created(id,url){
   if(typeof id!=='string'||id.length>128||sockets.has(id)||sockets.size>=8){malformed++;return}
   const allowed=url==='ws://127.0.0.1:46998/'
   if(!allowed)unexpected++
   sockets.set(id,{allowed,status:null,failed:false,closed:false,frontier:null,pending:new Set()})
  },
  handshake(id,status){const s=sockets.get(id);if(s)s.status=status},
  sent(id,raw){
   const s=sockets.get(id),r=parse(raw)
   if(!s?.allowed||r?.method!=='ledger.getFrontierMomentum'||!Number.isSafeInteger(r.id))return
   if(s.pending.size>=16){malformed++;return}
   s.pending.add(r.id)
  },
  received(id,raw){
   const s=sockets.get(id),r=parse(raw)
   if(!s?.allowed||!s.pending.delete(r?.id))return
   const m=r.result
   if(r.jsonrpc!=='2.0'||r.error||m?.chainIdentifier!==322||!Number.isSafeInteger(m.height)||m.height<20||typeof m.hash!=='string'||!/^[0-9a-f]{64}$/i.test(m.hash)){malformed++;return}
   s.frontier=m.height
  },
  failed(id){const s=sockets.get(id);if(s)s.failed=true},
  closed(id){const s=sockets.get(id);if(s)s.closed=true},
  report(){
   const rows=[...sockets.values()],valid=rows.filter(s=>s.allowed&&s.status===101&&s.frontier!==null)
   return {received:valid.length,errors:unexpected+rows.filter(s=>s.failed||s.closed||s.status!==null&&s.status!==101).length,
    invalid:malformed,open:valid.some(s=>!s.closed&&!s.failed),frontierHeight:valid.length?valid[0].frontier:null,socketCount:rows.length}
  },
 }
}
