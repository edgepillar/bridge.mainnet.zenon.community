import {expect,it} from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {readOfflineCrashEvidence} from '../../e2e/lib/browser-crash-evidence.mjs'

function owned(run:(directory:string)=>void){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'owned-crash-reader-control-'))
 try{run(directory)}finally{fs.rmSync(directory,{recursive:true})}
}
it('retains the real successful parser exit and complete output separately from empty evidence',()=>owned(directory=>{
 const report=readOfflineCrashEvidence(directory)
 expect(report.status).toBe('COMPLETE');expect(report.reports).toEqual([])
 expect(report.readerProcess).toEqual({state:'EXITED',actualExit:0,signal:null,outputComplete:true})
}))
it('retains the real refusal exit for a malformed owned dump without publishing its contents',()=>owned(directory=>{
 fs.mkdirSync(path.join(directory,'pending'))
 fs.writeFileSync(path.join(directory,'pending','00000000-0000-0000-0000-000000000000.dmp'),'synthetic-private-value@example.invalid')
 const report=readOfflineCrashEvidence(directory)
 expect(report.status).toBe('UNAVAILABLE');expect(report.readerProcess).toEqual({state:'EXITED',actualExit:1,signal:null,outputComplete:true})
 expect(JSON.stringify(report)).not.toContain('example.invalid')
 expect(report.rawDumpPublished).toBe(false)
}))
it('does not report success or a private path when the selected owned directory is absent',()=>owned(directory=>{
 const report=readOfflineCrashEvidence(path.join(directory,'absent'))
 expect(report.status).toBe('UNAVAILABLE');expect(report.readerProcess.actualExit).toBe(1)
 expect(JSON.stringify(report)).not.toContain(directory)
}))
