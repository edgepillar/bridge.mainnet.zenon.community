// The supervisor signals only its own RPC child, after a bound failure request.
// Challenges, requests, acknowledgements and raw stderr stay outside artifacts.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { randomUUID } from 'node:crypto'

const files={owner:'diagnostic-owner.private.json',request:'diagnostic-request.private.json',result:'diagnostic-result.private.json'}
const keys=['head','tree','buildKey','binaryHash','goCommit','goTree']
const object=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:null
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const identityValid=i=>object(i)&&Object.keys(i).length===keys.length&&keys.every(k=>Object.hasOwn(i,k)&&typeof i[k]==='string'&&new RegExp(`^[0-9a-f]{${['buildKey','binaryHash'].includes(k)?64:40}}$`).test(i[k]))
const sameIdentity=(a,b)=>identityValid(a)&&identityValid(b)&&keys.every(k=>a[k]===b[k])
export function identityForPostmortem({head,tree,build}){
 const value={head,tree,buildKey:build?.key,binaryHash:build?.binaryHash,goCommit:build?.sourceCommit,goTree:build?.sourceTree}
 if(!identityValid(value))throw new Error('Postmortem source identity unavailable')
 return value
}
export function ownedPostmortemController({identity,challenge,signalRpc}){
 if(!identityValid(identity)||typeof challenge!=='string'||!uuid.test(challenge)||typeof signalRpc!=='function')throw new Error('Postmortem owner unavailable')
 let requested=false,accepted=false
 return {
  accept(raw){
   if(requested||Buffer.byteLength(raw)>4096)return false
   let value;try{value=JSON.parse(raw.toString())}catch{return false}
   if(!object(value)||Object.keys(value).sort().join(',')!=='challenge,identity,kind'||value.kind!=='GOROUTINE_POSTMORTEM'||value.challenge!==challenge||!sameIdentity(value.identity,identity))return false
   requested=true
   try{accepted=signalRpc()===true}catch{/* A missing owned child remains unavailable. */}
   return accepted
  },
  exited(code,signal){return accepted?{status:'EXITED',challenge,identity,code:Number.isInteger(code)?code:null,signal:typeof signal==='string'?signal:null}:null},
 }
}
function directory(root){const s=fs.lstatSync(root);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('Postmortem directory unavailable')}
function exists(file){try{fs.lstatSync(file);return true}catch(e){if(e.code==='ENOENT')return false;throw new Error('Postmortem file unavailable')}}
function readRegular(file,cap,privateMode=false){
 const before=fs.lstatSync(file)
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>cap||(typeof process.getuid==='function'&&before.uid!==process.getuid())||(privateMode&&(before.mode&0o777)!==0o600))throw new Error('Postmortem file unavailable')
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)),buffer=Buffer.alloc(before.size)
 try{const opened=fs.fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino)throw new Error('Postmortem file changed');let at=0;while(at<buffer.length){const n=fs.readSync(fd,buffer,at,buffer.length-at,at);if(!n)throw new Error('Postmortem file incomplete');at+=n}}finally{fs.closeSync(fd)}
 const after=fs.lstatSync(file);if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size)throw new Error('Postmortem file changed')
 return buffer
}
function atomicPrivate(root,name,value){
 const raw=JSON.stringify(value);if(Buffer.byteLength(raw)>4096)throw new Error('Postmortem request bound')
 const target=path.join(root,name);if(exists(target))throw new Error('Existing postmortem evidence must be preserved')
 const temporary=path.join(root,name+'.'+randomUUID()+'.tmp'),fd=fs.openSync(temporary,'wx',0o600)
 try{fs.writeFileSync(fd,raw)}finally{fs.closeSync(fd)}
 fs.renameSync(temporary,target)
}
export async function attachOwnedPostmortem({directory:root,identity,signalRpc}){
 directory(root)
 if(Object.values(files).some(n=>exists(path.join(root,n))))throw new Error('Existing postmortem evidence must be preserved')
 const challenge=randomUUID(),controller=ownedPostmortemController({identity,challenge,signalRpc})
 const clients=new Set();let pending,connections=0
 const server=net.createServer(socket=>{
  clients.add(socket);socket.once('close',()=>clients.delete(socket));socket.on('error',()=>{})
  socket.setTimeout(3000,()=>socket.destroy())
  if(++connections>8){socket.destroy();return}
  let buffer=Buffer.alloc(0),received=false
  socket.on('data',chunk=>{
   if(received||buffer.length+chunk.length>4096){socket.destroy();return}
   buffer=Buffer.concat([buffer,chunk]);const end=buffer.indexOf('\n');if(end<0)return
   received=true
   if(end!==buffer.length-1){socket.destroy();return}
   pending=socket
   if(!controller.accept(buffer.subarray(0,end))){pending=undefined;socket.end(JSON.stringify({status:'REFUSED'}))}
  })
 })
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 const controlPort=server.address().port
 try{atomicPrivate(root,files.owner,{identity,challenge,controlPort})}catch(error){server.close();throw error}
 return {close(){for(const socket of clients)if(!socket.writableEnded)socket.destroy();server.close()},noteExit(code,signal){const result=controller.exited(code,signal);if(result){atomicPrivate(root,files.result,result);const response=pending;pending=undefined;response?.end(JSON.stringify(result),()=>response.destroy())}}}
}
export async function requestOwnedPostmortem({directory:root,identity,timeoutMs=3000}){
 directory(root)
 if(!identityValid(identity)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>3000)throw new Error('Postmortem request unavailable')
 const owner=JSON.parse(readRegular(path.join(root,files.owner),4096,true).toString())
 if(!object(owner)||!sameIdentity(owner.identity,identity)||typeof owner.challenge!=='string'||!uuid.test(owner.challenge)||!Number.isInteger(owner.controlPort)||owner.controlPort<1024||owner.controlPort>65535)throw new Error('Postmortem owner identity changed')
 const request={kind:'GOROUTINE_POSTMORTEM',identity,challenge:owner.challenge}
 atomicPrivate(root,files.request,request)
 const result=await new Promise((resolve,reject)=>{
  const socket=net.createConnection({host:'127.0.0.1',port:owner.controlPort});let buffer=Buffer.alloc(0),settled=false
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();if(error)reject(error);else resolve(value)}
  const timer=setTimeout(()=>finish(new Error('Postmortem deadline exceeded')),timeoutMs)
  socket.once('connect',()=>socket.write(JSON.stringify(request)+'\n'))
  socket.on('data',chunk=>{if(buffer.length+chunk.length>4096){finish(new Error('Postmortem response bound'));return}buffer=Buffer.concat([buffer,chunk])})
  socket.once('error',()=>finish(new Error('Postmortem transport unavailable')))
  socket.once('end',()=>{try{finish(null,JSON.parse(buffer.toString()))}catch{finish(new Error('Postmortem response unavailable'))}})
  socket.once('close',()=>finish(new Error('Postmortem response incomplete')))
 })
 if(result.status!=='EXITED'||result.challenge!==owner.challenge||!sameIdentity(result.identity,identity)||result.code!==2||result.signal!==null)throw new Error('Postmortem owned exit unavailable')
 const ack=JSON.parse(readRegular(path.join(root,files.result),4096,true).toString())
 if(JSON.stringify(ack)!==JSON.stringify(result))throw new Error('Postmortem acknowledgement changed')
 return readRegular(path.join(root,'rpc.log'),2*1024*1024).toString()
}
