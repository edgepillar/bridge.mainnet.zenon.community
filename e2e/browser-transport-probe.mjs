// Bounded fresh-browser experiment. Preserve fatal socket assertions and privacy.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import {createRequire} from 'node:module'
import crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {verifyProbePackage} from './lib/probe-package-lock.mjs'
import {probeLedgerRound} from './lib/probe-ledger-round.mjs'
import {verifiedBuild} from './lab/verify-build.mjs'
import {socketFailureClass} from './lib/socket-evidence.ts'
import {browserSignalEvidence} from './lib/browser-signal-evidence.ts'
import {compiledStartupEvidence,compiledScriptPath} from './lib/compiled-startup-evidence.mjs'
import {offlineCrashOptions,offlineReporterIdentity,readOfflineCrashEvidence,calibrateOfflineCrashReader} from './lib/browser-crash-evidence.mjs'
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const ci=process.env.GITHUB_ACTIONS==='true',parent=process.env.SPV_TASK_SCRATCH??(ci?process.env.RUNNER_TEMP:undefined)
if(!parent||!path.isAbsolute(parent)||!fs.statSync(parent).isDirectory())throw Error('Owned experiment scratch is required')
const free=fs.statfsSync(parent)
if(free.bavail*free.bsize<10*1024**3+384*1024**2)throw Error('Experiment free-space reservation refused')
const backend=process.env.BROWSER_PROBE_MODE??'synthetic'
if(!['synthetic','native','docker'].includes(backend))throw Error('Unknown browser experiment backend')
const clientKind=process.env.BROWSER_PROBE_CLIENT??'rpc'
if(!['rpc','compiled'].includes(clientKind)||backend==='synthetic'&&clientKind!=='rpc')throw Error('Unknown browser experiment client')
const compiled=clientKind==='compiled',labMode=backend==='synthetic'?null:backend,planned=ci?(compiled?24:labMode?12:48):12,work=fs.mkdtempSync(path.join(parent,'bridge-browser-transport-'))
const reportName=compiled?'lab-compiled-startup-report.json':labMode?'lab-transport-probe-report.json':'transport-probe-report.json'
const reportFile=ci?path.join(repo,'.browser-results',reportName):path.join(parent,reportName)
if(fs.existsSync(reportFile))throw Error('Reconcile the existing report before another experiment')
fs.mkdirSync(path.dirname(reportFile),{recursive:true})
const sha=b=>crypto.createHash('sha256').update(b).digest('hex')
const lockBytes=fs.readFileSync(path.join(repo,'package-lock.json')),lock=JSON.parse(lockBytes)
const sourceFiles=Object.fromEntries(['e2e/browser-transport-probe.mjs','e2e/lib/probe-ledger-round.mjs','e2e/lib/probe-package-lock.mjs','e2e/lib/browser-termination-evidence.ts','e2e/lib/browser-memory-evidence.ts','e2e/lib/browser-stderr-evidence.ts','e2e/lib/socket-evidence.ts','e2e/lib/browser-signal-evidence.ts','e2e/lib/browser-signal-watch.py','e2e/lib/compiled-startup-evidence.mjs','e2e/lib/browser-crash-evidence.mjs','e2e/lib/browser-crash-key.py'].map(n=>[n,sha(fs.readFileSync(path.join(repo,n)))]))
const memoryModule=await import(pathToFileURL(path.join(repo,'e2e/lib/browser-memory-evidence.ts')).href)
const stderrModule=await import(pathToFileURL(path.join(repo,'e2e/lib/browser-stderr-evidence.ts')).href)
const binaryHash=()=>{const file=process.env.CHROME_PATH,st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>1024**3)throw Error('Browser executable refused');const h=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(128*1024);try{for(;;){const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;h.update(buffer.subarray(0,n))}}finally{fs.closeSync(fd)}return h.digest('hex')}

const require=createRequire(path.join(repo,'package.json')),puppeteer=require('puppeteer-core').default,pupRequire=createRequire(require.resolve('puppeteer-core')),{WebSocketServer}=pupRequire('ws')
const actualPuppeteer=require('puppeteer-core/package.json').version,actualWs=pupRequire('ws/package.json').version
const resolvedPuppeteer=path.relative(repo,path.dirname(require.resolve('puppeteer-core/package.json'))).split(path.sep).join('/'),resolvedWs=path.relative(repo,path.dirname(pupRequire.resolve('ws/package.json'))).split(path.sep).join('/')
if(ci){verifyProbePackage(lock.packages,resolvedPuppeteer,actualPuppeteer);verifyProbePackage(lock.packages,resolvedWs,actualWs)}
const {browserTerminationEvidence}=await import(pathToFileURL(path.join(repo,'e2e/lib/browser-termination-evidence.ts')).href)
const payload=(id,size)=>{const start=JSON.stringify({jsonrpc:'2.0',id,result:{padding:''}});return Buffer.from(start.replace('"padding":""','"padding":"'+'x'.repeat(size-Buffer.byteLength(start))+'"'))}
const frame=(opcode,fin,data)=>{const h=Buffer.alloc(data.length<126?2:4);h[0]=(fin?128:0)|opcode;if(data.length<126)h[1]=data.length;else{h[1]=126;h.writeUInt16BE(data.length,2)}return Buffer.concat([h,data])}
let browser,server,wss,previewServer,currentTrial,currentMemory,currentStderr,currentTermination,currentSignal
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:repo}).toString().trim(),sourceTree=execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:repo}).toString().trim()
let goIdentity=null
if(labMode){
 const build=verifiedBuild(labMode),runtime=JSON.parse(fs.readFileSync(path.join(repo,'e2e/lab/.build',labMode,'run-manifest.json')))
 if(runtime.buildKey!==build.key)throw Error('Lab runtime identity differs')
 if(labMode==='native'){
  if(runtime.bridgeSourceCommit!==sourceCommit||runtime.bridgeSourceTree!==sourceTree||runtime.znndHash!==build.binaryHash)throw Error('Native source/runtime differs')
 }else if(runtime.sourceCommit!==sourceCommit||runtime.sourceTree!==sourceTree||runtime.sourceDirty||runtime.goSourceCommit!==build.pins.goZenonCommit||runtime.znndImageId!==build.imageId)throw Error('Docker source/runtime differs')
 goIdentity={mode:labMode,buildKey:build.key,goSourceCommit:build.sourceCommit,goSourceTree:build.sourceTree,downloaderSourceHash:build.downloaderSourceHash,runtimeId:labMode==='native'?build.binaryHash:build.imageId}
}
let compiledBundle=null
if(compiled){
 const previous=JSON.parse(fs.readFileSync(path.join(repo,'.browser-results/built-report.json')))
 if(previous.sourceCommit!==sourceCommit||previous.sourceTree!==sourceTree||previous.sourceDirty||previous.errors.length||previous.lockfileHash!==sha(lockBytes)||!Array.isArray(previous.initialScripts)||!previous.initialScripts.length)throw Error('Compiled fixture source differs or failed')
 const hashes={}
 for(const script of previous.initialScripts){
  const file=path.join(repo,'e2e/.state/browser-build',compiledScriptPath(script.name)),st=fs.lstatSync(file)
  if(!st.isFile()||st.isSymbolicLink()||st.size>4*1024**2||st.size!==script.bytes||sha(fs.readFileSync(file))!==script.sha256)throw Error('Compiled script bytes differ')
  hashes[script.name]=script.sha256
 }
 compiledBundle={reportSha256:sha(fs.readFileSync(path.join(repo,'.browser-results/built-report.json'))),initialScripts:hashes}
}
const result={schema:2,status:'RUNNING',sourceCommit,sourceTree,sourceDirty:execFileSync('git',['status','--porcelain'],{cwd:repo}).length>0,sourceFiles,lockfileHash:sha(lockBytes),nodeVersion:process.versions.node,platform:process.platform,arch:process.arch,actualPuppeteer,actualWs,resolvedPuppeteer,resolvedWs,browserHash:binaryHash(),backend,clientKind,goIdentity,compiledBundle,plannedTrials:planned,signals:0,trials:[],naturalFailureReproduced:false,rootCause:'NOT_ESTABLISHED',rawOutputPublished:false,fullNativeExecutions:0,liveChainWrites:0,scope:compiled?'Read-only fresh production-bundle startup in the existing qualified isolated Go lab; no wallet injection, signing, transfers or activation acceptance':labMode?'Read-only staged ledger reads against the already qualified isolated Go lab; no wallet, signing, transfer or activation acceptance':'Synthetic valid RFC6455 startup experiment; separate from application, native-chain and historical-failure acceptance'}
const save=()=>fs.writeFileSync(reportFile,JSON.stringify(result,null,2)+'\n')
if(ci&&result.sourceDirty)throw Error('CI source is dirty')
save()
try{
 if(compiled){
  const {preview}=await import('vite')
  previewServer=await preview({envDir:false,logLevel:'error',build:{outDir:'e2e/.state/browser-build'},preview:{host:'127.0.0.1',port:5195,strictPort:true}})
  server=previewServer.httpServer
 }else{
 server=http.createServer((_,r)=>{r.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"default-src 'self'; connect-src 'self'"+(labMode?' ws://127.0.0.1:46998':'')+"; script-src 'none'"});r.end('<!doctype html><title>Fragment startup control</title>')})
 if(!labMode){
 wss=new WebSocketServer({server,perMessageDeflate:false,maxPayload:65536})
 wss.on('connection',socket=>{let outgoing=Promise.resolve();socket.on('error',()=>{});socket.on('message',raw=>{outgoing=outgoing.then(async()=>{
  const request=JSON.parse(raw),data=payload(request.id,request.id===1?1319:15908)
  const split=request.mode==='EMPTY_FINAL_SPLIT',empty=request.mode!=='SINGLE_FINAL'
  if(socket._socket.destroyed)return
  if(empty){socket._socket.write(frame(1,false,data));if(split)await new Promise(resolve=>setImmediate(resolve));if(!socket._socket.destroyed)socket._socket.write(frame(0,true,Buffer.alloc(0)))}
  else socket._socket.write(frame(1,true,data))
 }).catch(()=>{if(!socket._socket.destroyed)socket._socket.destroy()})})})
 }
 // Native RPC already permits the compiled fixture's origin. Reuse it after
 // that fixture has closed; never widen its Origin policy for this probe.
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(labMode?5195:0,'127.0.0.1',resolve)})
 }
 const origin='http://127.0.0.1:'+server.address().port
 if(compiled){
  result.offlineCrashPolicy={status:'CONFIGURED_PINNED_UNATTENDED_POLICY',chromeHeadless:true,rawDumpArtifactIncluded:false,scope:'OWNED_CI_SCRATCH_ONLY'}
  result.offlineReporterIdentity=offlineReporterIdentity(process.env.CHROME_PATH)
  result.offlineCrashControl=await calibrateOfflineCrashReader(puppeteer,process.env.CHROME_PATH,work);save()
  if(result.offlineCrashControl.status!=='PASS')throw Error('Offline annotation control refused')
 }
 const started=Date.now()
 for(let index=0;index<planned;index++){
  if(Date.now()-started>150000)throw Error('Experiment time bound')
  const mode=compiled?'COMPILED_APPLICATION_STARTUP':labMode?'GO_RPC_STAGED':['SINGLE_FINAL','EMPTY_FINAL','EMPTY_FINAL_SPLIT'][index%3],interception=compiled||index%2===0
  const trial={index,mode,interception,expectedMessages:compiled?1:13,frameErrors:0,emptyFrameErrors:0,failureClasses:[],handshakeStatus:null,consoleErrors:0,outboundRequests:0,cspViolations:0,networkServiceChanged:null}
  currentTrial=trial
  currentStderr=undefined;currentTermination=undefined
  const profile=path.join(work,'profile-'+index),memory=memoryModule.browserMemoryEvidence()
  currentMemory=memory
  const crashDirectory=compiled?path.join(work,'crashes-'+index):null
  const crashOptions=compiled?offlineCrashOptions(puppeteer,crashDirectory):{}
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,userDataDir:profile,headless:true,...crashOptions})
  const stderr=stderrModule.browserStderrEvidence(!!browser.process().stderr),capture=chunk=>stderr.ingest(chunk)
  currentStderr=stderr
  browser.process().stderr?.on('data',capture)
  browser.process().stderr?.on('error',()=>stderr.captureReadError())
  const bs=await browser.target().createCDPSession(),version=await bs.send('Browser.getVersion')
  if(version.revision!=='@3ff7ac5a9224be9156d7f8703a06e22890aafd34'||!(await browser.version()).endsWith('155.0.8059.39'))throw Error('PINNED_BROWSER_REFUSED')
  result.browserRevision=version.revision;result.browserVersion=await browser.version()
  const pids=async()=>{
   let timer
   try{
    const value=await Promise.race([bs.send('SystemInfo.getProcessInfo'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Process snapshot deadline')),2000)})])
    if(!Array.isArray(value?.processInfo)||value.processInfo.length>64)throw Error('Process snapshot refused')
    const rows=value.processInfo.filter(x=>x.type==='network.mojom.NetworkService'),ids=new Set(rows.map(x=>x.id))
    if(ids.size!==rows.length||[...ids].some(id=>!Number.isSafeInteger(id)||id<=0))throw Error('Process snapshot refused')
    return ids
   }finally{clearTimeout(timer)}
  }
  const page=await browser.newPage(),session=await page.createCDPSession();await session.send('Network.enable')
  const startup=compiled?compiledStartupEvidence():null
  if(startup){
   session.on('Network.webSocketCreated',e=>startup.created(e.requestId,e.url))
   session.on('Network.webSocketHandshakeResponseReceived',e=>startup.handshake(e.requestId,e.response.status))
   session.on('Network.webSocketFrameSent',e=>startup.sent(e.requestId,e.response.payloadData))
   session.on('Network.webSocketFrameReceived',e=>startup.received(e.requestId,e.response.payloadData))
   session.on('Network.webSocketFrameError',e=>startup.failed(e.requestId))
   session.on('Network.webSocketClosed',e=>startup.closed(e.requestId))
   page.on('pageerror',()=>trial.consoleErrors++)
   await page.exposeFunction('__qualificationCspViolation',()=>trial.cspViolations++)
   await page.evaluateOnNewDocument(()=>document.addEventListener('securitypolicyviolation',()=>window.__qualificationCspViolation()))
  }
  page.on('console',m=>{if(m.type()==='error')trial.consoleErrors++})
  if(interception){await page.setRequestInterception(true);page.on('request',r=>{const url=new URL(r.url());if(compiled&&url.hostname!=='127.0.0.1'&&url.protocol!=='data:'){trial.outboundRequests++;void r.abort()}else void r.continue()})}
  // Establish the static owned origin before measuring its network service;
  // Linux may create that service lazily. No WebSocket exists yet.
  if(!compiled)await page.goto(origin,{waitUntil:'domcontentloaded'})
  const baseline=await pids(),termination=await browserTerminationEvidence(()=>bs.send('Browser.getHistograms',{query:'ChildProcess.',delta:false}),version.revision)
  currentTermination=termination
  trial.baselinePhase=compiled?'BEFORE_FIRST_COMPILED_NAVIGATION':'AFTER_STATIC_HTTP_BEFORE_WEBSOCKET'
  const initial=termination.report().baseline
  trial.initialUtilityFault=initial.status!=='COMPLETE'||Object.values(initial.counts).some(x=>x>0)
  trial.networkServicesBefore=baseline.size
  if(baseline.size!==1)throw Error('Network service baseline refused')
  session.on('Network.webSocketHandshakeResponseReceived',e=>{trial.handshakeStatus=e.response.status})
  session.on('Network.webSocketFrameError',e=>{trial.frameErrors++;if(e.errorMessage==='')trial.emptyFrameErrors++;if(trial.failureClasses.length<4)trial.failureClasses.push(socketFailureClass(e.errorMessage));termination.markFailure()})
  currentSignal=await browserSignalEvidence(browser.process()?.pid,()=>bs.send('SystemInfo.getProcessInfo'))
  if(compiled){
   await page.goto(origin,{waitUntil:'networkidle0'})
   await page.waitForFunction(()=>document.body.innerText.includes('Anvil'),{timeout:5000})
   await new Promise(resolve=>setTimeout(resolve,750));trial.client=startup.report()
  }else trial.client=labMode?await page.evaluate(probeLedgerRound,'ws://127.0.0.1:46998/'):await page.evaluate(async(mode)=>await new Promise(resolve=>{
   const socket=new WebSocket(location.origin.replace('http:','ws:')),received=new Set();let errors=0,invalid=0,settled=false
   const finish=()=>{if(!settled){settled=true;resolve({received:received.size,errors,invalid,open:socket.readyState===WebSocket.OPEN});socket.close(1000,'control complete')}}
   const timer=setTimeout(finish,5000)
   socket.onopen=()=>{for(let id=1;id<=13;id++)socket.send(JSON.stringify({jsonrpc:'2.0',id,mode,method:'control'}))}
   socket.onmessage=e=>{try{const x=JSON.parse(e.data);if(Number.isSafeInteger(x.id)&&x.id>=1&&x.id<=13&&validReply(x))received.add(x.id);else invalid++}catch{invalid++}if(received.size===13)setTimeout(()=>{clearTimeout(timer);finish()},750)}
   function validReply(x){return x.jsonrpc==='2.0'&&typeof x.result?.padding==='string'}
   socket.onerror=()=>{errors++};socket.onclose=()=>{if(received.size<13){clearTimeout(timer);finish()}}
  }),mode)
  await currentSignal.stop();trial.signalObservation=currentSignal.report();currentSignal=undefined
  await termination.captureAfterFailures();trial.termination=termination.report()
  try{const after=await pids();trial.networkServicesAfter=after.size;trial.networkServiceChanged=baseline.size!==after.size||[...baseline].some(x=>!after.has(x))}catch{trial.networkServiceChanged=null}
  const stderrFacts=stderr.report()
  const failed=trial.frameErrors||trial.consoleErrors||trial.outboundRequests||trial.cspViolations||trial.client.received!==trial.expectedMessages||trial.client.errors||trial.client.invalid||!trial.client.open||trial.networkServiceChanged!==false||trial.initialUtilityFault||stderrFacts.networkServiceRestarts||stderrFacts.fatalMessages||stderrFacts.mojoErrorMessages||Object.values(stderrFacts.signalNumbers).some(x=>x>0)
  if(failed)memory.captureAfterFailure()
  trial.memory=memory.report();trial.stderr=stderr.report()
  const child=browser.process();trial.ownedBrowserState={status:child.exitCode===null&&child.signalCode===null?'RUNNING':'EXITED',exitCode:child.exitCode,signal:child.signalCode===null?null:['SIGKILL','SIGTERM','SIGABRT','SIGSEGV','SIGSYS'].includes(child.signalCode)?child.signalCode:'OTHER'}
  if(compiled)trial.offlineCrashEvidence=readOfflineCrashEvidence(crashDirectory)
  await browser.close();browser=null
  result.trials.push(trial);save()
  if(failed){result.status='FAILURE_VALID_FIXTURE_TRANSPORT_LOSS';result.naturalFailureReproduced=trial.frameErrors>0&&trial.networkServiceChanged===true;break}
  if(compiled&&trial.offlineCrashEvidence.status!=='COMPLETE')throw Error('Offline annotation reader refused')
  fs.rmSync(profile,{recursive:true})
 }
 if(result.status==='RUNNING')result.status='PASS_NO_NATURAL_FAILURE_REPRODUCED'
}catch{
 result.status='CONTROL_FAILURE';result.failureCode='OWNED_EXPERIMENT_INCOMPLETE'
 if(currentTrial&&!result.trials.includes(currentTrial)){
  await currentSignal?.stop();currentTrial.signalObservation=currentSignal?.report()??{status:'UNAVAILABLE'};currentSignal=undefined
  currentMemory?.captureAfterFailure();currentTrial.memory=currentMemory?.report()??{status:'UNAVAILABLE'}
  currentTrial.stderr=currentStderr?.report()??{status:'UNAVAILABLE'}
  await currentTermination?.captureAfterFailures();currentTrial.termination=currentTermination?.report()??{status:'UNAVAILABLE'}
  const child=browser?.process();currentTrial.ownedBrowserState=child?{status:child.exitCode===null&&child.signalCode===null?'RUNNING':'EXITED',exitCode:child.exitCode,signal:child.signalCode===null?null:['SIGKILL','SIGTERM','SIGABRT','SIGSEGV','SIGSYS'].includes(child.signalCode)?child.signalCode:'OTHER'}:{status:'UNAVAILABLE'}
  currentTrial.complete=false;result.trials.push(currentTrial)
 }
}
finally{try{await browser?.close()}catch{result.status='CONTROL_FAILURE'}if(wss){for(const c of wss.clients)c.terminate();await new Promise(r=>wss.close(r))}if(previewServer)await previewServer.close();else if(server)await new Promise(r=>server.close(r))}
save()
if(result.status==='PASS_NO_NATURAL_FAILURE_REPRODUCED'){
 // Leave reporter scratch to the ephemeral runner; no dump-writer lifetime is
 // inferred from the main browser's exit, and raw dumps are never uploaded.
 if(!compiled)fs.rmSync(work,{recursive:true})
 console.log('Browser transport experiment passed: '+result.trials.length+' fresh starts, zero socket errors; natural historical cause remains unestablished.')
}else{
 console.error('Browser transport experiment failed; inspect its sanitized source-bound report.')
 process.exitCode=1
}
