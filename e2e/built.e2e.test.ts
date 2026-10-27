// Prepare the isolated fixture, then qualify compiled assets and the HTML CSP read-only.
// No wallet is injected and the only RPC endpoints are the isolated lab.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import type { Readable } from 'node:stream'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { build, preview, type PreviewServer } from 'vite'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { setup } from './setup.ts'
import { socketFailureClass } from './lib/socket-evidence.ts'
import { summarizeNetLog, summarizeNativeLog } from './lib/transport-diagnostics.ts'
import { browserProcessEvidence } from './lib/browser-process-evidence.ts'
import { browserStderrEvidence } from './lib/browser-stderr-evidence.ts'
import { browserTerminationEvidence } from './lib/browser-termination-evidence.ts'

const outDir='e2e/.state/browser-build', origin='http://127.0.0.1:5195'
const netLogFile='e2e/.state/compiled-netlog.private.json'
let server: PreviewServer, browser: Browser, page: Page
const errors:string[]=[], outbound:string[]=[], scripts=new Set<string>(), violations:string[]=[]
let initialScripts:string[]=[]
let noticeEvidence={verified:false,packages:0,files:0,manifestSha256:''}
let processEvidence: Awaited<ReturnType<typeof browserProcessEvidence>>, browserRevision: string | null = null
const pendingProcessEvidence: Promise<void>[] = []
let terminationEvidence:Awaited<ReturnType<typeof browserTerminationEvidence>>|undefined
let stderrEvidence = browserStderrEvidence(false)
let ownedBrowserStderr: Readable | null | undefined
const captureBrowserStderr = (chunk: Buffer) => stderrEvidence.ingest(chunk)
const captureBrowserStderrError = () => stderrEvidence.captureReadError()
// Keep bounded transport facts, never handshake headers or raw RPC frames.
const socketEvidence:{allowed:boolean;status:number|null;error:boolean;closed:boolean;frontier:{chainId:number;height:number}|null;
  createdMs:number;handshakeMs:number|null;errorMs:number|null;closedMs:number|null;frontierMs:number|null;failureClass:string|null;frontierRequests:number}[]=[]
const sha=(data:Buffer)=>crypto.createHash('sha256').update(data).digest('hex')
beforeAll(async()=>{
  // Vitest may run this file first by size or a cached failure. Establish the
  // committed loopback fixture here instead of relying on another test file.
  await setup()
  if(!process.env.CHROME_PATH)throw new Error('Set CHROME_PATH to the pinned browser')
  process.env.VITE_NETWORK='devnet'
  // Vitest sets NODE_ENV=test; that would otherwise retain development stores.
  const previousNodeEnv=process.env.NODE_ENV
  process.env.NODE_ENV='production'
  try { await build({envDir:false,logLevel:'error',mode:'production',build:{outDir,emptyOutDir:true}}) }
  finally { if(previousNodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousNodeEnv }
  server=await preview({envDir:false,logLevel:'error',build:{outDir},preview:{host:'127.0.0.1',port:5195,strictPort:true}})
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,args:['--log-net-log='+path.resolve(netLogFile)]})
  ownedBrowserStderr=browser.process()?.stderr
  stderrEvidence=browserStderrEvidence(!!ownedBrowserStderr)
  ownedBrowserStderr?.on('data',captureBrowserStderr)
  ownedBrowserStderr?.on('error',captureBrowserStderrError)
  if(process.env.EXPECTED_BROWSER_VERSION)expect((await browser.version()).endsWith(process.env.EXPECTED_BROWSER_VERSION)).toBe(true)
  page=await browser.newPage()
  const browserSession=await browser.target().createCDPSession()
  const version=await browserSession.send('Browser.getVersion')
  browserRevision=/^@[0-9a-f]{40}$/.test(version.revision)?version.revision:null
  processEvidence=await browserProcessEvidence(()=>browserSession.send('SystemInfo.getProcessInfo'))
  terminationEvidence=await browserTerminationEvidence(()=>browserSession.send('Browser.getHistograms',{query:'ChildProcess.',delta:false}),browserRevision)
  page.on('pageerror',(error)=>errors.push(String(error)))
  page.on('console',(message)=>{if(message.type()==='error')errors.push(message.text())})
  // The fixture controls only the selected loopback socket. Production assets
  // expose no test store or disconnect hook.
  await page.evaluateOnNewDocument(()=>{
    const NativeSocket=window.WebSocket
    let disconnect=()=>false
    window.WebSocket=class extends NativeSocket{
      constructor(url:string|URL,protocols?:string|string[]){
        super(url,protocols)
        if(this.url==='ws://127.0.0.1:46998/')disconnect=()=>{
          if(this.readyState!==NativeSocket.OPEN)return false
          this.close(1000,'qualification disconnect')
          return true
        }
      }
    }
    ;(window as any).__qualificationCloseTransport=()=>disconnect()
  })
  // HTTP readiness cannot prove the browser's WebSocket upgrade or RPC identity.
  const session=await page.createCDPSession()
  const sockets=new Map<string,{evidence:typeof socketEvidence[number];frontiers:Set<number>}>()
  const started=performance.now(),elapsed=()=>Math.round(performance.now()-started)
  await session.send('Network.enable')
  session.on('Network.webSocketCreated',({requestId,url})=>{
    if(socketEvidence.length>=16){errors.push('Compiled browser exceeded the WebSocket evidence bound');return}
    const evidence={allowed:url==='ws://127.0.0.1:46998/',status:null as number|null,error:false,closed:false,frontier:null as {chainId:number;height:number}|null,
      createdMs:elapsed(),handshakeMs:null as number|null,errorMs:null as number|null,closedMs:null as number|null,frontierMs:null as number|null,failureClass:null as string|null,frontierRequests:0}
    socketEvidence.push(evidence);sockets.set(requestId,{evidence,frontiers:new Set()})
    if(!evidence.allowed)outbound.push('UNEXPECTED_WEBSOCKET_ENDPOINT')
  })
  session.on('Network.webSocketHandshakeResponseReceived',({requestId,response})=>{
    const socket=sockets.get(requestId);if(socket){socket.evidence.status=response.status;socket.evidence.handshakeMs=elapsed()}
  })
  session.on('Network.webSocketFrameError',({requestId,errorMessage})=>{
    const socket=sockets.get(requestId);if(socket){socket.evidence.error=true;socket.evidence.errorMs=elapsed();socket.evidence.failureClass=socketFailureClass(errorMessage)}
    if(socket?.evidence.allowed){terminationEvidence?.markFailure();const diagnostic=processEvidence.captureFailure();if(pendingProcessEvidence.length<8)pendingProcessEvidence.push(diagnostic)}
  })
  session.on('Network.webSocketFrameSent',({requestId,response})=>{
    const socket=sockets.get(requestId);if(!socket||response.payloadData.length>64*1024)return
    try{
      const frame=JSON.parse(response.payloadData)
      if(frame?.method==='ledger.getFrontierMomentum'&&Number.isSafeInteger(frame.id)){
        if(socket.frontiers.size>=128){errors.push('Compiled browser exceeded the pending frontier evidence bound');return}
        socket.frontiers.add(frame.id)
        socket.evidence.frontierRequests++
      }
    }catch{/* Only paired frontier identities are retained. */}
  })
  session.on('Network.webSocketFrameReceived',({requestId,response})=>{
    const socket=sockets.get(requestId);if(!socket||response.payloadData.length>64*1024)return
    try{
      const frame=JSON.parse(response.payloadData)
      if(!socket.frontiers.delete(frame?.id))return
      const momentum=frame.result
      if(!frame.error&&Number.isSafeInteger(momentum?.chainIdentifier)&&Number.isSafeInteger(momentum?.height)&&/^[0-9a-f]{64}$/i.test(momentum?.hash)){
        socket.evidence.frontier={chainId:momentum.chainIdentifier,height:momentum.height};socket.evidence.frontierMs=elapsed()
      }
    }catch{/* Malformed or unrelated frames cannot establish readiness. */}
  })
  session.on('Network.webSocketClosed',({requestId})=>{
    const socket=sockets.get(requestId);if(socket){socket.evidence.closed=true;socket.evidence.closedMs=elapsed();socket.frontiers.clear()}
  })
  await page.exposeFunction('__labPolicyViolation',(directive:string)=>violations.push(directive))
  await page.evaluateOnNewDocument(()=>document.addEventListener('securitypolicyviolation',(event)=>(window as any).__labPolicyViolation(event.effectiveDirective)))
  await page.setRequestInterception(true)
  page.on('request',(request)=>{
    const url=new URL(request.url())
    if(url.hostname==='127.0.0.1'||url.protocol==='data:')void request.continue()
    else{outbound.push(url.origin);void request.abort()}
  })
  page.on('response',(response)=>{const url=new URL(response.url());if(url.origin===origin&&url.pathname.endsWith('.js'))scripts.add(url.pathname)})
  await page.goto(origin,{waitUntil:'networkidle0'})
  await page.waitForFunction(()=>document.body.innerText.includes('Anvil'),{timeout:60_000})
  initialScripts=[...scripts].sort()
})
afterAll(async()=>{
  let browserVersion: string | null = null
  try { browserVersion=await browser?.version()??null } catch { /* Preserve evidence even if the owned browser exited. */ }
  const socketSnapshot=JSON.parse(JSON.stringify(socketEvidence))
  const errorSnapshot=[...errors],outboundSnapshot=[...outbound],violationSnapshot=[...violations],loadedScriptNames=[...scripts].sort()
  await Promise.all(pendingProcessEvidence)
  await terminationEvidence?.captureAfterFailures()
  const browserTerminationDiagnostics=terminationEvidence?.report()??{status:'UNAVAILABLE'}
  const browserProcessDiagnostics=processEvidence?.report()??{status:'UNAVAILABLE'}
  const browserStderrDiagnostics=stderrEvidence.report()
  const child=browser?.process()
  const ownedBrowserState=child ? {status:child.exitCode===null&&child.signalCode===null?'RUNNING':'EXITED',
    exitCode:child.exitCode,signal:child.signalCode===null?null:['SIGKILL','SIGTERM','SIGABRT','SIGSEGV'].includes(child.signalCode)?child.signalCode:'OTHER'} : {status:'UNAVAILABLE'}
  let browserCloseStatus: 'COMPLETE' | 'UNAVAILABLE' | 'FAILED' = 'UNAVAILABLE'
  try { await browser?.close();browserCloseStatus=browser?'COMPLETE':'UNAVAILABLE' }
  catch { browserCloseStatus='FAILED' }
  finally { ownedBrowserStderr?.off('data',captureBrowserStderr);ownedBrowserStderr?.off('error',captureBrowserStderrError) }
  let transportEvidence:ReturnType<typeof summarizeNetLog>|{status:'UNAVAILABLE'}={status:'UNAVAILABLE'}
  const nativeDiagnostics:Record<string,unknown>={}
  try{
    if(fs.statSync(netLogFile).size>8*1024*1024)throw new Error('NetLog byte bound exceeded')
    transportEvidence=summarizeNetLog(JSON.parse(fs.readFileSync(netLogFile,'utf8')))
  }catch{/* Missing/incomplete evidence fails the hook after the report is saved. */}
  for(const role of ['rpc','pillar','pillar2','pillar3','observer']){
    const file=`e2e/lab/.build/native/${role}.log`
    if(!fs.existsSync(file))continue
    const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink())continue
    const bytes=Math.min(info.size,256*1024),buffer=Buffer.alloc(bytes),fd=fs.openSync(file,'r')
    try{fs.readSync(fd,buffer,0,bytes,info.size-bytes)}finally{fs.closeSync(fd)}
    nativeDiagnostics[role]={complete:info.size===bytes,bytesRead:bytes,...summarizeNativeLog(buffer.toString())}
  }
  const report={mode:'isolated read-only production bundle',network:'devnet',sourceCommit:execFileSync('git',['rev-parse','HEAD']).toString().trim(),
    sourceTree:execFileSync('git',['rev-parse','HEAD^{tree}']).toString().trim(),lockfileHash:sha(fs.readFileSync('package-lock.json')),
    sourceDirty:execFileSync('git',['status','--porcelain']).toString().trim().length>0,browserVersion,browserRevision,browserProcessDiagnostics,browserTerminationDiagnostics,browserStderrDiagnostics,ownedBrowserState,browserCloseStatus,errors:errorSnapshot,outbound:outboundSnapshot,violations:violationSnapshot,
    initialScripts:initialScripts.map((name)=>{const bytes=fs.readFileSync(path.join(outDir,name));return {name,bytes:bytes.length,gzipBytes:gzipSync(bytes).length,sha256:sha(bytes)}}),loadedScriptNames,noticeEvidence,socketEvidence:socketSnapshot,transportEvidence,nativeDiagnostics}
  fs.mkdirSync('.browser-results',{recursive:true});fs.writeFileSync('.browser-results/built-report.json',JSON.stringify(report,null,2)+'\n')
  await new Promise<void>((resolve)=>server?.httpServer.close(()=>resolve())??resolve())
  expect(browserCloseStatus).not.toBe('FAILED')
  expect(transportEvidence.status).toBe('COMPLETE')
  if('connections' in transportEvidence)expect(transportEvidence.connections.length).toBeGreaterThan(0)
})

it('loads compiled routes under the declared CSP without development stores or an external request',async()=>{
  await expect.poll(()=>socketEvidence.some((socket)=>socket.allowed&&socket.status===101&&!socket.error&&!socket.closed&&socket.frontier?.chainId===322&&socket.frontier.height>=20),{timeout:60_000}).toBe(true)
  expect(await page.evaluate(()=>(window as any).__bridge)).toBeUndefined()
  expect(await page.$eval('meta[http-equiv="Content-Security-Policy"]',(element)=>element.getAttribute('content'))).toContain("script-src 'self'")
  expect(errors).toEqual([]);expect(outbound).toEqual([]);expect(violations).toEqual([])
})

it('retains exact locked dependency and font notice bytes in the compiled distribution',()=>{
  const lockBytes=fs.readFileSync('package-lock.json'),lock=JSON.parse(lockBytes.toString())
  const noticeBytes=fs.readFileSync(path.join(outDir,'third-party-notices/manifest.json')),manifest=JSON.parse(noticeBytes.toString())
  const expected=Object.entries(lock.packages).filter(([name,entry])=>name&&!(entry as any).dev).map(([name])=>name).sort()
  expect(manifest.lockfileSha256).toBe(sha(lockBytes))
  expect(manifest.packages.map((p:any)=>p.packagePath).sort()).toEqual(expected)
  expect(manifest.packages.filter((p:any)=>p.name.startsWith('@fontsource-variable/')).every((p:any)=>p.license==='OFL-1.1')).toBe(true)
  let count=0
  for(const pkg of manifest.packages){
    expect(pkg.version).toBe(lock.packages[pkg.packagePath].version)
    expect(pkg.notices.length).toBeGreaterThan(0)
    for(const notice of pkg.notices){
      expect(path.isAbsolute(notice.output)||notice.output.split('/').includes('..')).toBe(false)
      expect(notice.source.startsWith(pkg.packagePath+'/')).toBe(true)
      const bytes=fs.readFileSync(path.join(outDir,'third-party-notices',notice.output))
      expect(sha(bytes)).toBe(notice.sha256);expect(bytes).toEqual(fs.readFileSync(notice.source));count++
    }
  }
  noticeEvidence={verified:true,packages:manifest.packages.length,files:count,manifestSha256:sha(noticeBytes)}
})

it('keeps compiled views within a mobile viewport with disconnected wallets',async()=>{
  await page.setViewport({width:375,height:900})
  for(const route of ['','activity','liquidity','stats','affiliate']) {
    await page.evaluate((value)=>{location.hash='#/'+value},route)
    await page.waitForFunction((value)=>document.querySelector('h1')?.textContent?.trim()===value,{},route?route[0].toUpperCase()+route.slice(1):'Bridge')
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0)
  }
  expect(errors).toEqual([]);expect(outbound).toEqual([]);expect(violations).toEqual([])
})

it('repeats compiled startup without losing a validated browser transport',async()=>{
  for(let attempt=0;attempt<4;attempt++){
    const firstSocket=socketEvidence.length
    await page.goto(origin+'?qualification-startup='+attempt,{waitUntil:'networkidle0'})
    await expect.poll(()=>socketEvidence.slice(firstSocket).some((socket)=>socket.allowed&&socket.status===101&&!socket.error&&!socket.closed&&socket.frontier?.chainId===322&&socket.frontier.height>=20),{timeout:60_000}).toBe(true)
    expect(await page.evaluate(()=>(window as any).__bridge)).toBeUndefined()
    expect(errors).toEqual([]);expect(outbound).toEqual([]);expect(violations).toEqual([])
  }
})

it('revalidates the compiled client frontier after an isolated transport disconnect',async()=>{
  const firstSocket=socketEvidence.length,previous=socketEvidence.at(-1)!
  expect(await page.evaluate(()=>(window as any).__qualificationCloseTransport())).toBe(true)
  await expect.poll(()=>previous.closed,{timeout:5_000}).toBe(true)
  await expect.poll(()=>socketEvidence.slice(firstSocket).some((socket)=>socket.allowed&&socket.status===101&&!socket.error&&!socket.closed&&socket.frontier?.chainId===322&&socket.frontier.height>=20),{timeout:60_000}).toBe(true)
  expect(await page.evaluate(()=>(window as any).__bridge)).toBeUndefined()
  expect(errors).toEqual([]);expect(outbound).toEqual([]);expect(violations).toEqual([])
})
