// Offline, owned CI diagnostics. Raw dumps and unrecognized strings stay private.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const reader=fileURLToPath(new URL('./browser-crash-key.py',import.meta.url))
const readerReasons=new Set(['FILE_BOUND','READ_BOUND','INCOMPLETE','LOCATION_BOUND','STRING_BOUND','STRING_TERMINATOR','COUNT_BOUND','ANNOTATION_RESERVED','HEADER','STREAM_BOUND','EXCEPTION_BOUND','DUPLICATE_CRASHPAD_STREAM','CRASHPAD_VERSION','DUPLICATE_MODULE','MISSING_MODULE','MODULE_VERSION','MESSAGE_COUNT','DIRECTORY','CHILD_DIRECTORY','DIRECTORY_COUNT','DUMP_COUNT','DUMP_IDENTITY','TOTAL_BOUND','DUMP_CHANGED','ARGUMENTS','UTF8_REFUSED','IO_MISSING','IO_PERMISSION','IO_REFUSED','STRUCTURE_REFUSED','FORMAT_REFUSED'])
export function calibrationFailureFacts(error){
 const text=typeof error?.message==='string'?error.message.slice(0,16384):''
 let category='UNCLASSIFIED'
 for(const [fragment,value] of [['Page has pending navigations','PENDING_NAVIGATION'],['Not attached to a page','NO_PAGE'],['wasn\'t found','UNSUPPORTED_COMMAND'],['Target closed','TARGET_CLOSED'],['error while loading shared libraries','MISSING_SHARED_LIBRARY'],['client.StartHandler','HANDLER_START_FAILED'],['--database is required','HANDLER_DATABASE_REQUIRED'],['Crash control deadline','CRASH_EVENT_DEADLINE'],['Crash control reader refused','ANNOTATION_READER_REFUSED'],['Calibration browser differs','BROWSER_IDENTITY_REFUSED'],['Reporter defaults differ','REPORTER_DEFAULTS_DIFFER']])if(text.includes(fragment)){category=value;break}
 return {category,messageSha256:crypto.createHash('sha256').update(text).digest('hex'),messageTruncated:typeof error?.message==='string'&&error.message.length>16384,protocolCode:Number.isSafeInteger(error?.code)&&Math.abs(error.code)<=1_000_000?error.code:null}
}
export async function offlineCrashOptions(puppeteer,directory){
 if(process.platform!=='linux'||process.env.GITHUB_ACTIONS!=='true'||!path.isAbsolute(directory))throw Error('Offline reporter scope refused')
 if(!(await puppeteer.defaultArgs()).includes('--disable-crash-reporter'))throw Error('Reporter defaults differ')
 fs.mkdirSync(directory,{mode:0o700})
 return {ignoreDefaultArgs:['--disable-crash-reporter'],args:['--enable-crash-reporter','--crash-dumps-dir='+directory],env:{...process.env,CHROME_HEADLESS:'1'}}
}
export function offlineReporterIdentity(browserPath){
 const pin=JSON.parse(fs.readFileSync(new URL('../lab/browser-reporter.pin.json',import.meta.url)))
 const file=path.join(path.dirname(browserPath),'chrome_crashpad_handler');let st
 try{st=fs.lstatSync(file)}catch{throw Error('PINNED_OFFLINE_REPORTER_MISSING')}
 if(!st.isFile()||st.isSymbolicLink()||st.size<=0||st.size>16*1024**2)throw Error('Pinned reporter executable refused')
 const sha256=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
 if(st.size!==pin.bytes||sha256!==pin.sha256)throw Error('PINNED_OFFLINE_REPORTER_IDENTITY_REFUSED')
 return {sha256,bytes:st.size}
}
export function readOfflineCrashEvidence(directory){
 const child=spawnSync('python3',['-B',reader,directory],{timeout:5000,maxBuffer:64*1024,stdio:['ignore','pipe','pipe']})
 const readerProcess={state:typeof child.status==='number'?'EXITED':child.signal?'SIGNALED':'UNKNOWN',actualExit:child.status,signal:child.signal,outputComplete:!child.error&&child.status!==null}
 let result
 try{
  if(!readerProcess.outputComplete)throw Error('Reader process refused')
  result=JSON.parse(child.stdout)
  if(child.status!==0)throw Error('Reader process refused')
  if(result.status!=='COMPLETE'||!Array.isArray(result.reports)||result.reports.length>8||result.rawDumpPublished!==false||result.otherAnnotationValuesRead!==false)throw Error('Reader output refused')
  return {...result,readerProcess}
 }catch{return {status:'UNAVAILABLE',reason:readerReasons.has(result?.reason)?result.reason:'OWNED_ANNOTATION_READ_REFUSED',rawDumpPublished:false,readerProcess}}
}

export function offlineRendererDumpControlPassed(control){
 const complete=report=>report?.status==='COMPLETE'&&Array.isArray(report.reports)&&report.rawDumpPublished===false&&report.otherAnnotationValuesRead===false&&report.readerProcess?.state==='EXITED'&&report.readerProcess.actualExit===0&&report.readerProcess.signal===null&&report.readerProcess.outputComplete===true
 if(control?.scope!=='OWNED_ABOUT_BLANK_RENDERER'||control.pageInitialized!==true||control.injectedRendererCrashRequests!==1||control.mainBrowserAlive!==true)return false
 if(!complete(control.baseline)||control.baseline.reports.length!==0||!complete(control.evidence)||control.evidence.reports.length!==1)return false
 if(!['COMPLETED','PENDING_AT_CRASH_OBSERVATION'].includes(control.protocolOutcomeBeforeTeardown)&&!(control.protocolOutcomeBeforeTeardown==='REJECTED'&&control.protocolFailure?.category==='TARGET_CLOSED'))return false
 const report=control.evidence.reports[0]
 // The pinned Linux x64 Page.crash control emits SIGTRAP (5). An arbitrary
 // dump, a browser/utility dump, or a pre-existing report cannot calibrate it.
 return report.status==='COMPLETE'&&report.crashpadStreamPresent===true&&Array.isArray(report.processTypes)&&report.processTypes.length===1&&report.processTypes[0]==='renderer'&&report.exceptionCode===5&&Number.isSafeInteger(report.bytesRead)&&report.bytesRead>0&&report.bytesRead<=2*1024**2&&report.rawDumpPublished===false&&report.otherAnnotationValuesRead===false&&Array.isArray(report.messages)&&report.messages.length===0
}

export async function calibrateOfflineCrashReader(puppeteer,executablePath,work){
 const directory=path.join(work,'calibration-crashes'),profile=path.join(work,'calibration-profile')
 let browser,phase='OPTIONS',ownedTarget
 const result={status:'FAILURE',scope:'OWNED_ABOUT_BLANK_RENDERER',phase,pageInitialized:false,pageCrashObserved:false,targetCrashObserved:false,injectedRendererCrashRequests:0,injectedRendererCrashes:0,dumpObserved:false,protocolOutcome:'NOT_REQUESTED',protocolOutcomeBeforeTeardown:'NOT_REQUESTED',mainBrowserAlive:false,browserCloseStatus:'NOT_STARTED',baseline:null,evidence:null,failure:null,rawDumpPublished:false}
 try{
  const defaults=await puppeteer.defaultArgs()
  result.defaultCrashFlags={disableCrashReporter:defaults.includes('--disable-crash-reporter'),disableBreakpad:defaults.includes('--disable-breakpad')}
  const options=await offlineCrashOptions(puppeteer,directory)
  const helper=spawnSync(path.join(path.dirname(executablePath),'chrome_crashpad_handler'),['--help'],{timeout:3000,maxBuffer:64*1024,stdio:['ignore','pipe','pipe']})
  result.helperProbe={actualExit:helper.status,signal:helper.signal,outputComplete:!helper.error&&helper.status!==null,stdoutBytes:helper.stdout?.length??0,stderrBytes:helper.stderr?.length??0,missingSharedLibrary:helper.stderr?.includes(Buffer.from('error while loading shared libraries'))??false}
  phase='LAUNCH'
  browser=await puppeteer.launch({executablePath,userDataDir:profile,headless:true,...options})
  phase='BROWSER_IDENTITY'
  const bs=await browser.target().createCDPSession(),version=await bs.send('Browser.getVersion')
  result.browserRevision=version.revision
  if(version.revision!=='@3ff7ac5a9224be9156d7f8703a06e22890aafd34')throw Error('Calibration browser differs')
  phase='PAGE_READY'
  const page=await browser.newPage(),session=await page.createCDPSession()
  page.on('error',()=>{result.pageCrashObserved=true})
  await session.send('Page.enable')
  // Commit the owned blank document before Page.crash; the protocol refuses a
  // target with pending navigation. No application or network request is used.
  await page.goto('about:blank',{waitUntil:'load',timeout:5000})
  result.pageInitialized=await page.evaluate(()=>location.href==='about:blank'&&document.readyState==='complete')
  if(!result.pageInitialized)throw Error('Owned blank page not ready')
  const target=await session.send('Target.getTargetInfo');ownedTarget=target.targetInfo.targetId
  bs.on('Target.targetCrashed',event=>{if(event.targetId===ownedTarget)result.targetCrashObserved=true})
  await bs.send('Target.setDiscoverTargets',{discover:true})
  phase='CRASH_BASELINE';result.baseline=readOfflineCrashEvidence(directory)
  if(result.baseline.status!=='COMPLETE'||result.baseline.reports.length!==0)throw Error('Crash control baseline refused')
  // This fresh about:blank renderer has no wallet, navigation or RPC connection.
  phase='CRASH_REQUEST';result.injectedRendererCrashRequests=1;result.protocolOutcome='PENDING_AT_CRASH_OBSERVATION'
  void session.send('Page.crash').then(()=>{result.protocolOutcome='COMPLETED'},error=>{result.protocolOutcome='REJECTED';result.protocolFailure=calibrationFailureFacts(error)})
  // Both headless CI controls retained real dumps without either CDP crash event.
  // Calibrate the reader against the actual new renderer dump, not an event.
  phase='WAIT_FOR_CRASH_DUMP'
  let report
  const until=Date.now()+5000
  do{
   report=readOfflineCrashEvidence(directory)
   result.evidence=report
   if(report.status!=='COMPLETE')throw Error('Crash control reader refused')
   if(report.reports.length)break
   await new Promise(resolve=>setTimeout(resolve,100))
  }while(Date.now()<until)
  const child=browser.process();result.mainBrowserAlive=child.exitCode===null&&child.signalCode===null
  result.protocolOutcomeBeforeTeardown=result.protocolOutcome
  const passed=offlineRendererDumpControlPassed(result)
  result.dumpObserved=passed;result.injectedRendererCrashes=passed?1:0
  result.status=passed?'PASS':'FAILURE';result.failure=passed?null:{category:'EXPECTED_RENDERER_ANNOTATION_NOT_OBSERVED'}
  phase='COMPLETE'
 }catch(error){result.failure=calibrationFailureFacts(error)}
 finally{
  result.phase=phase
  if(!result.evidence&&fs.existsSync(directory))result.evidence=readOfflineCrashEvidence(directory)
  const child=browser?.process();if(child)result.mainBrowserAlive=child.exitCode===null&&child.signalCode===null
  try{await browser?.close();result.browserCloseStatus=browser?'COMPLETE':'NOT_STARTED'}catch{result.browserCloseStatus='FAILED';result.status='FAILURE';result.failure={category:'OWNED_BROWSER_CLOSE_FAILED'}}
 }
 return result
}
