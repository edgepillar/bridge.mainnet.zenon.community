// Positive and negative owned controls for the non-Fetch qualification policy.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {directNetworkPolicy,fixtureConnectPolicy} from './lib/browser-network-policy.mjs'
import {calibrationFailureFacts} from './lib/browser-crash-evidence.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),parent=process.env.RUNNER_TEMP
if(process.env.GITHUB_ACTIONS!=='true'||process.platform!=='linux'||!parent||!path.isAbsolute(parent)||!fs.statSync(parent).isDirectory())throw Error('Owned Linux network control required')
const free=fs.statfsSync(parent);if(free.bavail*free.bsize<10*1024**3+384*1024**2)throw Error('Network control reservation refused')
const file=path.join(root,'.browser-results/network-policy-control.json');if(fs.existsSync(file))throw Error('Reconcile existing network control evidence')
const work=fs.mkdtempSync(path.join(parent,'owned-direct-network-control-')),require=createRequire(path.join(root,'package.json'))
const puppeteer=require('puppeteer-core').default,wsRequire=createRequire(require.resolve('puppeteer-core')),{WebSocketServer}=wsRequire('ws')
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex'),pin=JSON.parse(fs.readFileSync(new URL('./lab/browser-reporter.pin.json',import.meta.url)))
const names=['e2e/browser-network-control.mjs','e2e/lib/browser-network-policy.mjs','e2e/lib/browser-crash-evidence.mjs','e2e/lab/browser-reporter.pin.json']
const result={schema:1,status:'RUNNING',phase:'IDENTITY',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim(),sourceTree:execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:root}).toString().trim(),sourceDirty:execFileSync('git',['status','--porcelain'],{cwd:root}).length>0,
 sourceFiles:Object.fromEntries(names.map(n=>[n,sha(fs.readFileSync(path.join(root,n)))])),lockfileHash:sha(fs.readFileSync(path.join(root,'package-lock.json'))),nodeVersion:process.versions.node,platform:process.platform,arch:process.arch,actualPuppeteer:require('puppeteer-core/package.json').version,actualWs:wsRequire('ws/package.json').version,
 scope:'OWNED_LOOPBACK_NETWORK_POLICY_CONTROLS_ONLY',fetchInterception:false,expectedDeniedRequests:2,fullNativeExecutions:0,liveChainWrites:0,rawOutputPublished:false}
let browser,allowedServer,deniedServer,wss
let allowedHits=0,deniedHits=0,deniedUpgrades=0,blockedHttp=0
try{
 if(result.sourceDirty)throw Error('Network control source is dirty')
 const executable=process.env.CHROME_PATH,info=fs.lstatSync(executable)
 if(!info.isFile()||info.isSymbolicLink()||info.size>256*1024**2)throw Error('Network control browser refused')
 const hash=crypto.createHash('sha256'),fd=fs.openSync(executable,'r'),buffer=Buffer.alloc(128*1024)
 try{for(;;){const size=fs.readSync(fd,buffer,0,buffer.length,null);if(!size)break;hash.update(buffer.subarray(0,size))}}finally{fs.closeSync(fd)}
 result.browserHash=hash.digest('hex');if(result.browserHash!==pin.browserSha256)throw Error('Network control browser identity differs')
 allowedServer=http.createServer((request,response)=>{
  response.setHeader('Content-Security-Policy',fixtureConnectPolicy(result.allowedOrigins))
  if(request.url==='/allowed'){allowedHits++;response.setHeader('Content-Type','application/json');response.end('{"owned":true}')}
  else{response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Owned network control</title>')}
 })
 deniedServer=http.createServer((_,response)=>{deniedHits++;response.end('Unexpected owned request')})
 deniedServer.on('upgrade',(_,socket)=>{deniedUpgrades++;socket.destroy()})
 const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 await listen(allowedServer);await listen(deniedServer)
 const origin='http://127.0.0.1:'+allowedServer.address().port,websocket='ws://127.0.0.1:'+allowedServer.address().port
 const deniedOrigin='http://127.0.0.1:'+deniedServer.address().port,deniedSocket='ws://127.0.0.1:'+deniedServer.address().port
 result.allowedOrigins=[origin,websocket]
 wss=new WebSocketServer({server:allowedServer});wss.on('connection',socket=>{socket.on('error',()=>{});socket.send('guard-ok')})
 result.phase='LAUNCH';browser=await puppeteer.launch({executablePath:executable,userDataDir:path.join(work,'profile'),headless:true})
 const bs=await browser.target().createCDPSession();result.browserRevision=(await bs.send('Browser.getVersion')).revision
 if(result.browserRevision!=='@3ff7ac5a9224be9156d7f8703a06e22890aafd34')throw Error('Network control browser revision differs')
 const page=await browser.newPage(),session=await page.createCDPSession(),pending=new Set()
 await session.send('Network.enable');result.phase='POLICY'
 await session.send('Network.setBlockedURLs',directNetworkPolicy(result.allowedOrigins))
 session.on('Network.requestWillBeSent',e=>{if(e.request.url===deniedOrigin+'/blocked.png')pending.add(e.requestId)})
 session.on('Network.loadingFailed',e=>{if(pending.delete(e.requestId)&&e.blockedReason==='inspector')blockedHttp++})
 await page.evaluateOnNewDocument(()=>{window.__ownedConnectBlocks=0;document.addEventListener('securitypolicyviolation',e=>{if(e.effectiveDirective==='connect-src')window.__ownedConnectBlocks++})})
 await page.goto(origin,{waitUntil:'networkidle0'})
 const processes=async()=>new Set((await bs.send('SystemInfo.getProcessInfo')).processInfo.filter(p=>p.type==='network.mojom.NetworkService').map(p=>p.id))
 const before=await processes();if(before.size!==1)throw Error('Network control process baseline differs')
 result.phase='POSITIVE_AND_NEGATIVE_CONTROLS'
 result.client=await page.evaluate(async({origin,websocket,deniedOrigin,deniedSocket})=>{
  const allowedHttp=(await(await fetch(origin+'/allowed')).json()).owned===true
  const socket=url=>new Promise(resolve=>{
   let ws,timer,settled=false
   const finish=value=>{if(!settled){settled=true;clearTimeout(timer);try{ws?.close()}catch{/* Only this owned control is closed. */}resolve(value)}}
   try{ws=new WebSocket(url);ws.onmessage=e=>finish(e.data==='guard-ok');ws.onerror=()=>finish(false);timer=setTimeout(()=>finish(false),3000)}catch{finish(false)}
  })
  const allowedWebSocket=await socket(websocket)
  const deniedImage=await new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(false);image.onerror=()=>resolve(true);image.src=deniedOrigin+'/blocked.png'})
  const deniedWebSocket=!(await socket(deniedSocket))
  return {allowedHttp,allowedWebSocket,deniedImage,deniedWebSocket}
 },{origin,websocket,deniedOrigin,deniedSocket})
 await new Promise(resolve=>setTimeout(resolve,100))
 const after=await processes(),child=browser.process()
 result.policyEvidence={allowedHttpHits:allowedHits,deniedHttpHits:deniedHits,deniedWebSocketUpgrades:deniedUpgrades,httpBlockedByInspector:blockedHttp,connectHeaderBlocks:await page.evaluate(()=>window.__ownedConnectBlocks),networkServicesBefore:before.size,networkServicesAfter:after.size,networkServiceChanged:before.size!==after.size||[...before].some(id=>!after.has(id)),mainBrowserAlive:child.exitCode===null&&child.signalCode===null}
 if(Object.values(result.client).some(value=>value!==true)||allowedHits!==1||deniedHits||deniedUpgrades||blockedHttp!==1||result.policyEvidence.connectHeaderBlocks<1||result.policyEvidence.networkServiceChanged||!result.policyEvidence.mainBrowserAlive)throw Error('Owned network policy control failed')
 result.phase='COMPLETE';result.status='PASS'
}catch(error){result.status='FAILURE';result.failure=calibrationFailureFacts(error)}
finally{
 try{await browser?.close()}catch{result.status='FAILURE';result.browserCloseFailed=true}
 if(wss){for(const client of wss.clients)client.terminate();await new Promise(resolve=>wss.close(resolve))}
 for(const server of [allowedServer,deniedServer])if(server?.listening)await new Promise(resolve=>server.close(resolve))
}
fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n')
console.log('Owned direct network policy control: '+result.status+'. Sanitized evidence retained.')
if(result.status!=='PASS')process.exitCode=1
