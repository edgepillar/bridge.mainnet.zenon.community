import {expect,it,vi} from 'vitest'
import fs from 'node:fs'
import puppeteer from 'puppeteer-core'
import {calibrationFailureFacts,offlineCrashOptions,offlineRendererDumpControlPassed} from '../../e2e/lib/browser-crash-evidence.mjs'
it('classifies protocol refusal without emitting the message',()=>{
 const report=calibrationFailureFacts(Object.assign(new Error('Protocol error (Page.crash): Page has pending navigations, not killing'),{code:-32000}))
 expect(report.category).toBe('PENDING_NAVIGATION');expect(report.protocolCode).toBe(-32000)
 expect(report).not.toHaveProperty('message')
})
it('keeps an arbitrary private failure out of structured diagnostics',()=>{
 const report=calibrationFailureFacts({message:'private@example.invalid /private/path token=synthetic',code:'private-value'})
 expect(report.category).toBe('UNCLASSIFIED');expect(report.protocolCode).toBeNull()
 expect(JSON.stringify(report)).not.toMatch(/example.invalid|private\/path|token=|private-value/)
})
it('bounds the selected error and records truncation explicitly',()=>{
 const report=calibrationFailureFacts({message:'x'.repeat(17000),code:1_000_001})
 expect(report.messageTruncated).toBe(true);expect(report.protocolCode).toBeNull();expect(report.messageSha256).toMatch(/^[a-f0-9]{64}$/)
})
it('handles absent and non-string error fields without decoding them',()=>{
 expect(calibrationFailureFacts(null).category).toBe('UNCLASSIFIED')
 expect(calibrationFailureFacts({message:{secret:'synthetic'}}).category).toBe('UNCLASSIFIED')
})

async function ownedCiScope(control:()=>Promise<void>){
 const platform=Object.getOwnPropertyDescriptor(process,'platform')!
 const github=process.env.GITHUB_ACTIONS
 const mkdir=vi.spyOn(fs,'mkdirSync').mockImplementation(()=>undefined)
 Object.defineProperty(process,'platform',{...platform,value:'linux'})
 process.env.GITHUB_ACTIONS='true'
 try{await control()}finally{
  Object.defineProperty(process,'platform',platform)
  if(github===undefined)delete process.env.GITHUB_ACTIONS
  else process.env.GITHUB_ACTIONS=github
  mkdir.mockRestore()
 }
}
it('awaits the installed Puppeteer defaults before preparing offline launch options',async()=>ownedCiScope(async()=>{
 const defaults=puppeteer.defaultArgs()
 expect(defaults).toBeInstanceOf(Promise)
 expect(await defaults).toContain('--disable-crash-reporter')
 const options=await offlineCrashOptions(puppeteer,'/owned-ci-crash-control')
 expect(options.ignoreDefaultArgs).toEqual(['--disable-crash-reporter'])
 expect(options.args).toEqual(['--enable-crash-reporter','--crash-dumps-dir=/owned-ci-crash-control'])
 expect(options.env.CHROME_HEADLESS).toBe('1')
 expect(fs.mkdirSync).toHaveBeenCalledExactlyOnceWith('/owned-ci-crash-control',{mode:0o700})
}))
it('preserves the reporter-default guard when an asynchronous provider omits the flag',async()=>ownedCiScope(async()=>{
 await expect(offlineCrashOptions({defaultArgs:async()=>[]},'/owned-ci-crash-control')).rejects.toThrow('Reporter defaults differ')
 expect(fs.mkdirSync).not.toHaveBeenCalled()
}))

function dumpControl(){
 const readerProcess={state:'EXITED',actualExit:0,signal:null,outputComplete:true}
 return {scope:'OWNED_ABOUT_BLANK_RENDERER',pageInitialized:true,injectedRendererCrashRequests:1,mainBrowserAlive:true,protocolOutcomeBeforeTeardown:'PENDING_AT_CRASH_OBSERVATION',pageCrashObserved:false,targetCrashObserved:false,
  baseline:{status:'COMPLETE',reports:[],rawDumpPublished:false,otherAnnotationValuesRead:false,readerProcess},
  evidence:{status:'COMPLETE',rawDumpPublished:false,otherAnnotationValuesRead:false,readerProcess:{...readerProcess},reports:[{status:'COMPLETE',crashpadStreamPresent:true,messages:[],processTypes:['renderer'],exceptionCode:5,bytesRead:1297,rawDumpPublished:false,otherAnnotationValuesRead:false}]}}
}
it('calibrates the actual new renderer dump when optional CDP crash events are absent',()=>{
 expect(offlineRendererDumpControlPassed(dumpControl())).toBe(true)
})
it('rejects an absent or nonempty pre-crash baseline',()=>{
 const control=dumpControl()
 expect(offlineRendererDumpControlPassed({...control,baseline:null})).toBe(false)
 expect(offlineRendererDumpControlPassed({...control,baseline:{...control.baseline,reports:control.evidence.reports}})).toBe(false)
})
it('requires the actual complete reader outcome before qualifying a dump',()=>{
 for(const readerProcess of [{state:'EXITED',actualExit:1,signal:null,outputComplete:true},{state:'SIGNALED',actualExit:null,signal:'SIGTERM',outputComplete:false}]){
  const control=dumpControl();expect(offlineRendererDumpControlPassed({...control,evidence:{...control.evidence,readerProcess}})).toBe(false)
 }
})
it('rejects unrelated, multiple, wrong-signal and incomplete dump evidence',()=>{
 for(const changed of [{exceptionCode:11},{processTypes:['browser']},{crashpadStreamPresent:false},{rawDumpPublished:true},{messages:[{}]},{bytesRead:3*1024**2}]){
  const control=dumpControl();expect(offlineRendererDumpControlPassed({...control,evidence:{...control.evidence,reports:[{...control.evidence.reports[0],...changed}]}})).toBe(false)
 }
 const control=dumpControl();expect(offlineRendererDumpControlPassed({...control,evidence:{...control.evidence,reports:[...control.evidence.reports,...control.evidence.reports]}})).toBe(false)
})
it('requires one owned request, a ready blank page, a live browser and an unrefused command',()=>{
 for(const changed of [{scope:'OTHER'},{pageInitialized:false},{injectedRendererCrashRequests:0},{injectedRendererCrashRequests:2},{mainBrowserAlive:false},{protocolOutcomeBeforeTeardown:'REJECTED',protocolFailure:{category:'PENDING_NAVIGATION'}}]){
  expect(offlineRendererDumpControlPassed({...dumpControl(),...changed})).toBe(false)
 }
 expect(offlineRendererDumpControlPassed(null)).toBe(false)
})
