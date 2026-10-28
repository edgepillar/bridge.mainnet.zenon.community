// Self-contained so Puppeteer can serialize the same read-only client function.
// The first frontier response releases the later reads, as application startup does.
export async function probeLedgerRound(endpoint){
 const empty={received:0,errors:0,invalid:1,open:false,frontierHeight:null}
 let url
 try{url=new URL(endpoint)}catch{return empty}
 if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.hash||url.search||url.pathname!=='/'||!Number.isInteger(Number(url.port))||Number(url.port)<1||Number(url.port)>65535)return empty
 return await new Promise(resolve=>{
  const socket=new WebSocket(url.href),received=new Set();let errors=0,invalid=0,settled=false,frontierHeight=null
  const finish=()=>{
   if(settled)return
   settled=true;clearTimeout(timer)
   resolve({received:received.size,errors,invalid,open:socket.readyState===WebSocket.OPEN,frontierHeight})
   socket.close(1000,'read-only control complete')
  }
  const timer=setTimeout(finish,5000)
  socket.onopen=()=>socket.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'ledger.getFrontierMomentum',params:[]}))
  socket.onerror=()=>{errors++}
  socket.onclose=()=>{if(received.size<13)finish()}
  socket.onmessage=event=>{
   if(settled)return
   try{
    if(typeof event.data!=='string'||event.data.length>1024*1024)throw Error()
    const reply=JSON.parse(event.data)
    if(reply.jsonrpc!=='2.0'||reply.error||!Number.isSafeInteger(reply.id)||reply.id<1||reply.id>13||received.has(reply.id))throw Error()
    const valid=m=>m?.chainIdentifier===322&&Number.isSafeInteger(m.height)&&m.height>=1&&/^[0-9a-f]{64}$/i.test(m.hash)
    if(reply.id===1){
     if(!valid(reply.result)||reply.result.height<20)throw Error()
     frontierHeight=reply.result.height;received.add(1)
     for(let id=2;id<=13;id++)socket.send(JSON.stringify({jsonrpc:'2.0',id,method:'ledger.getMomentumsByPage',params:[0,30]}))
    }else{
     if(frontierHeight===null||!Array.isArray(reply.result?.list)||reply.result.list.length<1||reply.result.list.length>30||!reply.result.list.every(valid))throw Error()
     received.add(reply.id)
    }
    if(received.size===13)setTimeout(finish,750)
   }catch{invalid++;finish()}
  }
 })
}
