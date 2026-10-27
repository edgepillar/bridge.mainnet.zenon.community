// Offline, owned CI diagnostics. Raw dumps and unrecognized strings stay private.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const reader=fileURLToPath(new URL('./browser-crash-key.py',import.meta.url))
export function offlineCrashOptions(puppeteer,directory){
 if(process.platform!=='linux'||process.env.GITHUB_ACTIONS!=='true'||!path.isAbsolute(directory))throw Error('Offline reporter scope refused')
 if(!puppeteer.defaultArgs().includes('--disable-crash-reporter'))throw Error('Reporter defaults differ')
 fs.mkdirSync(directory,{mode:0o700})
 return {ignoreDefaultArgs:['--disable-crash-reporter'],args:['--enable-crash-reporter','--crash-dumps-dir='+directory],env:{...process.env,CHROME_HEADLESS:'1'}}
}
export function offlineReporterIdentity(browserPath){
 const file=path.join(path.dirname(browserPath),'chrome_crashpad_handler'),st=fs.lstatSync(file)
 if(!st.isFile()||st.isSymbolicLink()||st.size<=0||st.size>16*1024**2)throw Error('Pinned reporter executable refused')
 return {sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),bytes:st.size}
}
export function readOfflineCrashEvidence(directory){
 try{
  const raw=execFileSync('python3',['-B',reader,directory],{timeout:5000,maxBuffer:64*1024,stdio:['ignore','pipe','ignore']})
  const result=JSON.parse(raw)
  if(result.status!=='COMPLETE'||!Array.isArray(result.reports)||result.reports.length>8||result.rawDumpPublished!==false||result.otherAnnotationValuesRead!==false)throw Error('Reader output refused')
  return result
 }catch{return {status:'UNAVAILABLE',reason:'OWNED_ANNOTATION_READ_REFUSED',rawDumpPublished:false}}
}

export async function calibrateOfflineCrashReader(puppeteer,executablePath,work){
 const directory=path.join(work,'calibration-crashes'),profile=path.join(work,'calibration-profile')
 const options=offlineCrashOptions(puppeteer,directory)
 let browser
 try{
  browser=await puppeteer.launch({executablePath,userDataDir:profile,headless:true,...options})
  const bs=await browser.target().createCDPSession(),version=await bs.send('Browser.getVersion')
  if(version.revision!=='@3ff7ac5a9224be9156d7f8703a06e22890aafd34')throw Error('Calibration browser differs')
  const page=await browser.newPage(),session=await page.createCDPSession()
  let observed=false,protocolOutcome='PENDING_AT_CRASH_OBSERVATION',timer,observeCrash
  const crashSeen=new Promise(resolve=>{observeCrash=resolve})
  page.on('error',()=>{observed=true;observeCrash()})
  // This fresh about:blank renderer has no wallet, navigation or RPC connection.
  void session.send('Page.crash').then(()=>{protocolOutcome='COMPLETED'},()=>{protocolOutcome='REJECTED'})
  try{await Promise.race([crashSeen,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Crash control deadline')),5000)})])}finally{clearTimeout(timer)}
  let report
  const until=Date.now()+5000
  do{
   report=readOfflineCrashEvidence(directory)
   if(report.status!=='COMPLETE')throw Error('Crash control reader refused')
   if(report.reports.length)break
   await new Promise(resolve=>setTimeout(resolve,100))
  }while(Date.now()<until)
  const child=browser.process(),alive=child.exitCode===null&&child.signalCode===null
  const passed=observed&&alive&&report.reports.some(x=>x.crashpadStreamPresent&&x.processTypes.includes('renderer')&&x.exceptionCode!==null)
  return {status:passed?'PASS':'FAILURE',injectedRendererCrashes:1,scope:'OWNED_ABOUT_BLANK_RENDERER',pageCrashObserved:observed,protocolOutcome,mainBrowserAlive:alive,evidence:report,rawDumpPublished:false}
 }finally{await browser?.close()}
}
