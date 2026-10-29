// Fast owned renderer calibration before any expensive chain qualification.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {calibrateOfflineCrashReader,offlineReporterIdentity,calibrationFailureFacts} from './lib/browser-crash-evidence.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),parent=process.env.RUNNER_TEMP
if(process.env.GITHUB_ACTIONS!=='true'||process.platform!=='linux'||!parent||!path.isAbsolute(parent)||!fs.statSync(parent).isDirectory())throw Error('Owned Linux CI control scope required')
const free=fs.statfsSync(parent);if(free.bavail*free.bsize<10*1024**3+384*1024**2)throw Error('Control storage reservation refused')
const file=path.join(root,'.browser-results/offline-crash-control.json');if(fs.existsSync(file))throw Error('Existing control evidence requires reconciliation')
fs.mkdirSync(path.dirname(file),{recursive:true});const work=fs.mkdtempSync(path.join(parent,'owned-offline-crash-control-'))
const require=createRequire(path.join(root,'package.json')),puppeteer=require('puppeteer-core').default,sha=data=>crypto.createHash('sha256').update(data).digest('hex')
const names=['e2e/browser-crash-control.mjs','e2e/lib/browser-crash-evidence.mjs','e2e/lib/browser-crash-key.py','e2e/lib/reporter-component.mjs','e2e/lab/browser-reporter.pin.json','e2e/lab/install-browser-reporter.mjs']
const result={schema:1,status:'RUNNING',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim(),sourceTree:execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:root}).toString().trim(),sourceDirty:execFileSync('git',['status','--porcelain'],{cwd:root}).length>0,sourceFiles:Object.fromEntries(names.map(n=>[n,sha(fs.readFileSync(path.join(root,n)))])),lockfileHash:sha(fs.readFileSync(path.join(root,'package-lock.json'))),nodeVersion:process.versions.node,platform:process.platform,arch:process.arch,actualPuppeteer:require('puppeteer-core/package.json').version,fullNativeExecutions:0,liveChainWrites:0,rawDumpPublished:false,scope:'OWNED_BLANK_RENDERER_CALIBRATION_ONLY_NOT_NATURAL_FAILURE_ACCEPTANCE'}
try{
 if(result.sourceDirty)throw Error('CI source is dirty')
 result.reporterIdentity=offlineReporterIdentity(process.env.CHROME_PATH)
 result.control=await calibrateOfflineCrashReader(puppeteer,process.env.CHROME_PATH,work)
 result.status=result.control.status==='PASS'?'PASS':'FAILURE'
}catch(error){result.status='FAILURE';result.failure=calibrationFailureFacts(error)}
fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n')
console.log('Owned offline renderer calibration: '+result.status+'. Sanitized evidence retained; raw dumps excluded.')
if(result.status!=='PASS')process.exitCode=1
