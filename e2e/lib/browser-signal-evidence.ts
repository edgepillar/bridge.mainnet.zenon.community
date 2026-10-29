// Optional Linux CI observation. Identifiers stay in the owned helper protocol;
// only fixed, validated categories enter the browser report.
import {spawn} from 'node:child_process'
import path from 'node:path'

const roles=['OWNED_BROWSER','OWNED_BROWSER_DESCENDANT','OWNED_NETWORK_SERVICE','OTHER_PROCESS','KERNEL_CONTEXT','UNRESOLVED']
const signals=['SIGINT','SIGILL','SIGTRAP','SIGABRT','SIGBUS','SIGKILL','SIGSEGV','SIGTERM','SIGSYS','OTHER']
export function sanitizeSignalReport(value:unknown){
 const r=value as Record<string,any>|null
 if(!r||!['COMPLETE','INCOMPLETE','UNAVAILABLE'].includes(r.status)||r.scope!=='OWNED_INITIAL_NETWORK_SERVICE_INITIAL_THREADS'||!Array.isArray(r.events)||r.events.length>64||r.rawTracePublished!==false||r.injectedSignals!==0||typeof r.truncated!=='boolean'||!Number.isSafeInteger(r.parseErrors)||r.parseErrors<0)throw Error('Signal report refused')
 const events=r.events.map((e:any)=>{
  if(!e||!signals.includes(e.signal)||!roles.includes(e.senderRole)||!['SI_USER','SI_TKILL','SI_KERNEL','OTHER'].includes(e.codeClass)||!['ACCEPTED','IGNORED','ALREADY_PENDING','OVERFLOW_FAIL','LOSE_INFO'].includes(e.generationResult))throw Error('Signal event refused')
  return {signal:e.signal,senderRole:e.senderRole,codeClass:e.codeClass,generationResult:e.generationResult}
 })
 if(r.status==='COMPLETE'&&(r.targetOwnershipVerified!==true||!Number.isSafeInteger(r.observedInitialThreads)||r.observedInitialThreads<1||r.observedInitialThreads>64||r.kernelBufferLosses!==0||r.truncated||r.parseErrors!==0))throw Error('Incomplete signal observation')
 if(!['NOT_STARTED','WINDOW_EXPIRED','REQUESTED_PRE_TEARDOWN','TARGET_EXIT_OR_REPLACED'].includes(r.stopReason)||r.maximumWindowSeconds!==15)throw Error('Signal window refused')
 return {status:r.status,scope:r.scope,events,truncated:r.truncated,parseErrors:r.parseErrors,rawTracePublished:false,injectedSignals:0,targetOwnershipVerified:r.targetOwnershipVerified===true,observedInitialThreads:Number.isSafeInteger(r.observedInitialThreads)?r.observedInitialThreads:null,kernelBufferLosses:Number.isSafeInteger(r.kernelBufferLosses)?r.kernelBufferLosses:null,stopReason:r.stopReason,maximumWindowSeconds:15}
}

export function completedSignalReport(value:unknown,actualExit:number|null,signal:string|null){
 let report:Record<string,unknown>
 try{report=sanitizeSignalReport(value)}catch{report={status:'UNAVAILABLE',reason:'OWNED_SIGNAL_OBSERVATION_REFUSED',rawTracePublished:false}}
 const helperProcess={state:actualExit===null&&signal===null?'UNKNOWN':'EXITED',actualExit,signal:signal===null?null:['SIGKILL','SIGTERM','SIGABRT','SIGSEGV'].includes(signal)?signal:'OTHER'}
 if(actualExit!==0||signal!==null)report.status='UNAVAILABLE'
 return {...report,helperProcess}
}

export async function browserSignalEvidence(browser:number|undefined,query:()=>Promise<unknown>){
 let value:Record<string,unknown>={status:'UNAVAILABLE',reason:'NOT_ENABLED',rawTracePublished:false}
 if(process.env.BROWSER_SIGNAL_TRACE!=='1')return {report:()=>value,stop:async()=>{}}
 const rows=(await query() as {processInfo?:unknown})?.processInfo
 if(!Number.isSafeInteger(browser)||!Array.isArray(rows)||rows.length>64)throw Error('Owned signal target refused')
 const targets=rows.filter(x=>x.type==='network.mojom.NetworkService')
 if(targets.length!==1||!Number.isSafeInteger(targets[0].id)||targets[0].id<=1)throw Error('Owned signal target refused')
 const child=spawn('sudo',['-n','python3',path.resolve('e2e/lib/browser-signal-watch.py'),'--watch',String(browser),String(targets[0].id)],{stdio:['pipe','pipe','pipe']})
 let pending='',bytes=0,closed=false,ready=false,stopping=false,resolveReady:()=>void=()=>{},resolveClose:()=>void=()=>{}
 const readyPromise=new Promise<void>(resolve=>{resolveReady=resolve}),closePromise=new Promise<void>(resolve=>{resolveClose=resolve})
 const refused=()=>{const prior=value.helperProcess;value={status:'UNAVAILABLE',reason:'OWNED_SIGNAL_OBSERVATION_REFUSED',rawTracePublished:false,...(prior?{helperProcess:prior}:{})}}
 child.stdout.on('data',(chunk:Buffer)=>{
  bytes+=chunk.length
  if(bytes>32768){refused();return}
  pending+=chunk.toString()
  while(pending.includes('\n')){
   const index=pending.indexOf('\n'),line=pending.slice(0,index);pending=pending.slice(index+1)
   try{
    const x=JSON.parse(line)
    if(x.kind==='READY'&&!ready){ready=true;resolveReady()}
    else if(x.kind==='RESULT')value=sanitizeSignalReport(x.report)
    else refused()
   }catch{refused()}
  }
 })
 child.stderr.on('data',()=>{/* Raw helper diagnostics are never published. */})
 child.stdin.on('error',()=>{if(!closed)refused()})
 child.stdout.on('error',refused)
 child.on('error',()=>{refused();resolveReady()})
 child.on('close',(code,signal)=>{value=completedSignalReport(value,code,signal);closed=true;resolveReady();resolveClose()})
 let timer:ReturnType<typeof setTimeout>|undefined
 try{await Promise.race([readyPromise,new Promise<void>(resolve=>{timer=setTimeout(resolve,2500)})])}finally{clearTimeout(timer)}
 if(!ready)refused()
 return {
  report:()=>({...value,helperOutputComplete:closed&&bytes<=32768&&pending===''}),
  async stop(){
   if(!closed&&!stopping){stopping=true;child.stdin.write('STOP\n',()=>{});child.stdin.end()}
   let deadline:ReturnType<typeof setTimeout>|undefined
   try{await Promise.race([closePromise,new Promise<void>(resolve=>{deadline=setTimeout(()=>{refused();resolve()},20000)})])}finally{clearTimeout(deadline)}
   if(pending)refused()
  },
 }
}
