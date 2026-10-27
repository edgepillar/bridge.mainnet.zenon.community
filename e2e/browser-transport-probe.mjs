// Bounded fresh-browser experiment. Preserve fatal socket assertions and privacy.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import {createRequire} from 'node:module'
import crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {verifyProbePackage} from './lib/probe-package-lock.mjs'
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const ci=process.env.GITHUB_ACTIONS==='true',parent=process.env.SPV_TASK_SCRATCH??(ci?process.env.RUNNER_TEMP:undefined)
if(!parent||!path.isAbsolute(parent)||!fs.statSync(parent).isDirectory())throw Error('Owned experiment scratch is required')
const free=fs.statfsSync(parent)
if(free.bavail*free.bsize<10*1024**3+128*1024**2)throw Error('Experiment free-space reservation refused')
const planned=ci?48:12,work=fs.mkdtempSync(path.join(parent,'bridge-browser-transport-'))
const reportFile=ci?path.join(repo,'.browser-results/transport-probe-report.json'):path.join(parent,'transport-probe-report.json')
if(fs.existsSync(reportFile))throw Error('Reconcile the existing report before another experiment')
fs.mkdirSync(path.dirname(reportFile),{recursive:true})
const sha=b=>crypto.createHash('sha256').update(b).digest('hex')
const lockBytes=fs.readFileSync(path.join(repo,'package-lock.json')),lock=JSON.parse(lockBytes)
const sourceFiles=Object.fromEntries(['e2e/browser-transport-probe.mjs','e2e/lib/probe-package-lock.mjs','e2e/lib/browser-termination-evidence.ts','e2e/lib/browser-memory-evidence.ts','e2e/lib/browser-stderr-evidence.ts'].map(n=>[n,sha(fs.readFileSync(path.join(repo,n)))]))
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
let browser,server,wss,currentTrial,currentMemory,currentStderr,currentTermination
const result={schema:1,status:'RUNNING',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo}).toString().trim(),sourceTree:execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:repo}).toString().trim(),sourceDirty:execFileSync('git',['status','--porcelain'],{cwd:repo}).length>0,sourceFiles,lockfileHash:sha(lockBytes),nodeVersion:process.versions.node,platform:process.platform,arch:process.arch,actualPuppeteer,actualWs,resolvedPuppeteer,resolvedWs,browserHash:binaryHash(),plannedTrials:planned,signals:0,trials:[],naturalFailureReproduced:false,rootCause:'NOT_ESTABLISHED',rawOutputPublished:false,fullNativeExecutions:0,scope:'Synthetic valid RFC6455 startup experiment; separate from application, native-chain and historical-failure acceptance'}
const save=()=>fs.writeFileSync(reportFile,JSON.stringify(result,null,2)+'\n')
if(ci&&result.sourceDirty)throw Error('CI source is dirty')
save()
try{
 server=http.createServer((_,r)=>{r.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"default-src 'self'; connect-src 'self'; script-src 'none'"});r.end('<!doctype html><title>Fragment startup control</title>')})
 wss=new WebSocketServer({server,perMessageDeflate:false,maxPayload:65536})
 wss.on('connection',socket=>{let outgoing=Promise.resolve();socket.on('error',()=>{});socket.on('message',raw=>{outgoing=outgoing.then(async()=>{
  const request=JSON.parse(raw),data=payload(request.id,request.id===1?1319:15908)
  const split=request.mode==='EMPTY_FINAL_SPLIT',empty=request.mode!=='SINGLE_FINAL'
  if(socket._socket.destroyed)return
  if(empty){socket._socket.write(frame(1,false,data));if(split)await new Promise(resolve=>setImmediate(resolve));if(!socket._socket.destroyed)socket._socket.write(frame(0,true,Buffer.alloc(0)))}
  else socket._socket.write(frame(1,true,data))
 }).catch(()=>{if(!socket._socket.destroyed)socket._socket.destroy()})})})
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});const origin='http://127.0.0.1:'+server.address().port
 const started=Date.now()
 for(let index=0;index<planned;index++){
  if(Date.now()-started>150000)throw Error('Experiment time bound')
  const mode=['SINGLE_FINAL','EMPTY_FINAL','EMPTY_FINAL_SPLIT'][index%3],interception=index%2===0
  const trial={index,mode,interception,expectedMessages:13,frameErrors:0,emptyFrameErrors:0,consoleErrors:0,networkServiceChanged:null}
  currentTrial=trial
  currentStderr=undefined;currentTermination=undefined
  const profile=path.join(work,'profile-'+index),memory=memoryModule.browserMemoryEvidence()
  currentMemory=memory
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,userDataDir:profile,headless:true})
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
  page.on('console',m=>{if(m.type()==='error')trial.consoleErrors++})
  if(interception){await page.setRequestInterception(true);page.on('request',r=>void r.continue())}
  // Establish the static owned origin before measuring its network service;
  // Linux may create that service lazily. No WebSocket exists yet.
  await page.goto(origin,{waitUntil:'domcontentloaded'})
  const baseline=await pids(),termination=await browserTerminationEvidence(()=>bs.send('Browser.getHistograms',{query:'ChildProcess.',delta:false}),version.revision)
  currentTermination=termination
  trial.baselinePhase='AFTER_STATIC_HTTP_BEFORE_WEBSOCKET'
  const initial=termination.report().baseline
  trial.initialUtilityFault=initial.status!=='COMPLETE'||Object.values(initial.counts).some(x=>x>0)
  trial.networkServicesBefore=baseline.size
  if(baseline.size!==1)throw Error('Network service baseline refused')
  session.on('Network.webSocketFrameError',e=>{trial.frameErrors++;if(e.errorMessage==='')trial.emptyFrameErrors++;termination.markFailure()})
  trial.client=await page.evaluate(async(mode)=>await new Promise(resolve=>{
   const socket=new WebSocket(location.origin.replace('http:','ws:')),received=new Set();let errors=0,invalid=0,settled=false
   const finish=()=>{if(!settled){settled=true;resolve({received:received.size,errors,invalid,open:socket.readyState===WebSocket.OPEN});socket.close(1000,'control complete')}}
   const timer=setTimeout(finish,5000)
   socket.onopen=()=>{for(let id=1;id<=13;id++)socket.send(JSON.stringify({jsonrpc:'2.0',id,mode,method:'control'}))}
   socket.onmessage=e=>{try{const x=JSON.parse(e.data);if(Number.isSafeInteger(x.id)&&x.id>=1&&x.id<=13&&validReply(x))received.add(x.id);else invalid++}catch{invalid++}if(received.size===13)setTimeout(()=>{clearTimeout(timer);finish()},750)}
   function validReply(x){return x.jsonrpc==='2.0'&&typeof x.result?.padding==='string'}
   socket.onerror=()=>{errors++};socket.onclose=()=>{if(received.size<13){clearTimeout(timer);finish()}}
  }),mode)
  await termination.captureAfterFailures();trial.termination=termination.report()
  try{const after=await pids();trial.networkServicesAfter=after.size;trial.networkServiceChanged=baseline.size!==after.size||[...baseline].some(x=>!after.has(x))}catch{trial.networkServiceChanged=null}
  const stderrFacts=stderr.report()
  const failed=trial.frameErrors||trial.consoleErrors||trial.client.received!==13||trial.client.errors||trial.client.invalid||!trial.client.open||trial.networkServiceChanged!==false||trial.initialUtilityFault||stderrFacts.networkServiceRestarts||stderrFacts.fatalMessages||stderrFacts.mojoErrorMessages||Object.values(stderrFacts.signalNumbers).some(x=>x>0)
  if(failed)memory.captureAfterFailure()
  trial.memory=memory.report();trial.stderr=stderr.report()
  const child=browser.process();trial.ownedBrowserState={status:child.exitCode===null&&child.signalCode===null?'RUNNING':'EXITED',exitCode:child.exitCode,signal:child.signalCode===null?null:['SIGKILL','SIGTERM','SIGABRT','SIGSEGV','SIGSYS'].includes(child.signalCode)?child.signalCode:'OTHER'}
  await browser.close();browser=null
  result.trials.push(trial);save()
  if(failed){result.status='FAILURE_VALID_FIXTURE_TRANSPORT_LOSS';result.naturalFailureReproduced=trial.frameErrors>0&&trial.networkServiceChanged===true;break}
  fs.rmSync(profile,{recursive:true})
 }
 if(result.status==='RUNNING')result.status='PASS_NO_NATURAL_FAILURE_REPRODUCED'
}catch{
 result.status='CONTROL_FAILURE';result.failureCode='OWNED_EXPERIMENT_INCOMPLETE'
 if(currentTrial&&!result.trials.includes(currentTrial)){
  currentMemory?.captureAfterFailure();currentTrial.memory=currentMemory?.report()??{status:'UNAVAILABLE'}
  currentTrial.stderr=currentStderr?.report()??{status:'UNAVAILABLE'}
  await currentTermination?.captureAfterFailures();currentTrial.termination=currentTermination?.report()??{status:'UNAVAILABLE'}
  const child=browser?.process();currentTrial.ownedBrowserState=child?{status:child.exitCode===null&&child.signalCode===null?'RUNNING':'EXITED',exitCode:child.exitCode,signal:child.signalCode===null?null:['SIGKILL','SIGTERM','SIGABRT','SIGSEGV','SIGSYS'].includes(child.signalCode)?child.signalCode:'OTHER'}:{status:'UNAVAILABLE'}
  currentTrial.complete=false;result.trials.push(currentTrial)
 }
}
finally{try{await browser?.close()}catch{result.status='CONTROL_FAILURE'}if(wss){for(const c of wss.clients)c.terminate();await new Promise(r=>wss.close(r))}if(server)await new Promise(r=>server.close(r))}
save()
if(result.status==='PASS_NO_NATURAL_FAILURE_REPRODUCED'){
 fs.rmSync(work,{recursive:true})
 console.log('Browser transport experiment passed: '+result.trials.length+' fresh starts, zero socket errors; natural historical cause remains unestablished.')
}else{
 console.error('Browser transport experiment failed; inspect its sanitized source-bound report.')
 process.exitCode=1
}
