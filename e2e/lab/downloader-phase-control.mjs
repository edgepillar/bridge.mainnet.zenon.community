// Run only on the isolated CI runner or inside an admitted local task-storage
// command. Go itself stays offline and raw command output stays private.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { downloaderPhaseReset, resetDownloaderPhase } from './downloader-phase-reset.mjs'

const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../..')
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
const packageName='github.com/zenon-network/go-zenon/protocol/downloader'
const regressionName='TestSynchroniseDoesNotReusePreviousHashCompletion'
const maxOutput=8*1024*1024

export function summarizeGoTest(output){
  if(!Buffer.isBuffer(output)||output.length>maxOutput)throw new Error('Invalid bounded Go test output')
  const result={passed:0,failed:0,skipped:0,uniqueTests:0,regressionPassed:0,regressionFailed:0,packageResult:null,expectedStall:false,expectedWaitGraph:false}
  const names=new Set()
  try{
    for(const line of output.toString('utf8').trim().split('\n')){
      if(line.length>64*1024)throw new Error()
      const event=JSON.parse(line)
      if(event.Package!==packageName||!['start','run','output','pass','fail','skip','pause','cont','bench'].includes(event.Action))throw new Error()
      if(event.Test!==undefined){
        if(typeof event.Test!=='string'||event.Test.length>200)throw new Error()
        names.add(event.Test);if(names.size>64)throw new Error()
        if(event.Action==='pass'){result.passed++;if(event.Test===regressionName)result.regressionPassed++}
        if(event.Action==='fail'){result.failed++;if(event.Test===regressionName)result.regressionFailed++}
        if(event.Action==='skip')result.skipped++
      }else if(['pass','fail'].includes(event.Action))result.packageResult=event.Action
      if(typeof event.Output==='string'){
        if(event.Output.includes('next synchronization stalled: height=5 pending=2 cached=0 active=1'))result.expectedStall=true
        if(event.Output.includes('CONTROL_WAIT_GRAPH=HASH_COMPLETION_HANDOFF_WITHOUT_BLOCK_FETCHER'))result.expectedWaitGraph=true
      }
    }
  }catch{throw new Error('Invalid bounded Go test schema')}
  result.uniqueTests=names.size
  return result
}

async function qualify(){
  const managed=process.env.SPV_TASK_SCRATCH,ci=process.env.GITHUB_ACTIONS==='true'
  const parent=managed??(ci?process.env.RUNNER_TEMP:undefined)
  if(!parent||!path.isAbsolute(parent)||!fs.statSync(parent).isDirectory())throw new Error('Owned qualification scratch is required')
  const available=fs.statfsSync(parent)
  if(available.bavail*available.bsize<10*1024**3+512*1024**2)throw new Error('Qualification free-space reservation refused')
  const checkout=process.env.GO_ZENON_DIR,go=process.env.LAB_GO_BIN??(ci?'go':undefined)
  if(!checkout||!go||(!ci&&!process.env.LAB_GO_MODCACHE))throw new Error('Pinned Go inputs and managed cache are required')
  const reportDir=ci?path.join(here,'.build'):managed
  fs.mkdirSync(reportDir,{recursive:true})
  const privateDir=path.join(reportDir,'downloader-control.private');fs.mkdirSync(privateDir,{mode:0o700})
  const reportFile=path.join(reportDir,'downloader-control-report.json')
  if(fs.existsSync(reportFile))throw new Error('Reconcile the existing control report before another execution')
  const work=fs.mkdtempSync(path.join(parent,'bridge-downloader-phase-'))
  const env={...process.env,GOTOOLCHAIN:'local',GOENV:'off',GOWORK:'off',GOTELEMETRY:'off',GOAUTH:'off',
    GOVCS:'*:off',GOPROXY:'off',GOSUMDB:'off',GOPRIVATE:'',GONOPROXY:'',GONOSUMDB:'',GOINSECURE:'',
    GOFLAGS:'',GOEXPERIMENT:'',GODEBUG:'',GOCACHEPROG:'',GOCOVERDIR:'',CGO_ENABLED:'0',GOMAXPROCS:'2',
    GOTMPDIR:path.join(work,'tmp'),TMPDIR:path.join(work,'tmp')}
  if(managed){env.GOMODCACHE=process.env.LAB_GO_MODCACHE;env.GOCACHE=path.join(work,'cache')}
  fs.mkdirSync(env.GOTMPDIR,{mode:0o700})
  const report={schema:1,status:'RUNNING',sourceCommit:null,sourceTree:null,sourceDirty:null,goVersion:null,
    goSource:downloaderPhaseReset,archiveSha256:null,goModSha256:null,goSumSha256:null,buildKey:null,
    probeSha256:null,stages:[],fullNodeExecutions:0,rawOutputPublished:false,ownedWorkspaceRetained:true}
  const save=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n')
  const run=(label,command,args,{cwd=repo,limit=maxOutput,timeout=240000,input,retainRaw=true}={})=>{
    const child=spawnSync(command,args,{cwd,env,encoding:null,maxBuffer:limit,timeout,input})
    const stdout=child.stdout??Buffer.alloc(0),stderr=child.stderr??Buffer.alloc(0)
    if(retainRaw)fs.writeFileSync(path.join(privateDir,label+'.stdout'),stdout,{mode:0o600})
    fs.writeFileSync(path.join(privateDir,label+'.stderr'),stderr,{mode:0o600})
    const evidence={phase:label,actualExit:child.status,complete:!child.error&&!child.signal,
      stdout:{sha256:sha(stdout),bytes:stdout.length},stderr:{sha256:sha(stderr),bytes:stderr.length}}
    report.stages.push(evidence);save()
    if(!evidence.complete)throw new Error('Incomplete bounded command')
    return {stdout,evidence}
  }
  const success=(label,command,args,options)=>{const result=run(label,command,args,options);if(result.evidence.actualExit!==0)throw new Error('Command refused');return result.stdout}
  try{
    const pins=JSON.parse(fs.readFileSync(path.join(here,'pins.json')))
    if(pins.goZenonCommit!==downloaderPhaseReset.sourceCommit||pins.goZenonTree!==downloaderPhaseReset.sourceTree)throw new Error('Source pins differ')
    const build=JSON.parse(fs.readFileSync(path.join(here,'.build/manifest.json')))
    if(build.mode!=='native'||build.downloaderSourceHash!==downloaderPhaseReset.patchedSha256||JSON.stringify(build.downloaderPatch)!==JSON.stringify(downloaderPhaseReset))throw new Error('Patched native build identity differs')
    if(sha(fs.readFileSync(path.join(here,'.build/znnd')))!==build.binaryHash)throw new Error('Native binary differs')
    report.buildKey=build.key
    report.sourceCommit=success('bridge-head','git',['rev-parse','HEAD']).toString().trim()
    report.sourceTree=success('bridge-tree','git',['rev-parse','HEAD^{tree}']).toString().trim()
    report.sourceDirty=success('bridge-clean','git',['status','--porcelain']).length!==0
    if(report.sourceDirty)throw new Error('Bridge source is dirty')
    const sourceHead=success('go-head','git',['-C',checkout,'rev-parse','HEAD']).toString().trim()
    const sourceTree=success('go-tree','git',['-C',checkout,'rev-parse','HEAD^{tree}']).toString().trim()
    if(sourceHead!==pins.goZenonCommit||sourceTree!==pins.goZenonTree)throw new Error('Go checkout pin differs')
    report.goVersion=success('go-version',go,['version']).toString().trim()
    if(!report.goVersion.includes('go'+pins.goVersion+' ')||report.goVersion!==build.goVersion)throw new Error('Compiler version differs')
    const archive=success('go-archive','git',['-C',checkout,'archive',pins.goZenonCommit],{limit:64*1024*1024,timeout:60000,retainRaw:false})
    report.archiveSha256=sha(archive)
    if(report.archiveSha256!=='9a80c8011afefaf35d4e3475d87bab6df5a4407a96af1ea26ea9b231a01313b9')throw new Error('Go archive differs')
    const source=path.join(work,'source');fs.mkdirSync(source,{mode:0o700})
    success('extract-source','tar',['-x','-C',source],{input:archive,timeout:60000})
    report.goModSha256=sha(fs.readFileSync(path.join(source,'go.mod')))
    report.goSumSha256=sha(fs.readFileSync(path.join(source,'go.sum')))
    const test=(label,args)=>{const result=run(label,go,['test','-mod=readonly','-buildvcs=false','-json','-timeout=45s',...args,'./protocol/downloader'],{cwd:source});return {...result,summary:summarizeGoTest(result.stdout)}}
    const baseline=test('original-baseline',['-count=1'])
    if(baseline.evidence.actualExit!==0||baseline.summary.passed!==9||baseline.summary.uniqueTests!==9||baseline.summary.failed||baseline.summary.skipped||baseline.summary.packageResult!=='pass')throw new Error('Baseline refused')
    const probe=fs.readFileSync(path.join(here,'downloader/phase_completion_test.go'));report.probeSha256=sha(probe)
    fs.writeFileSync(path.join(source,'protocol/downloader/phase_completion_control_test.go'),probe,{mode:0o600})
    const original=test('unpatched-stall',['-count=1','-run','^'+regressionName+'$'])
    if(original.evidence.actualExit!==1||original.summary.regressionFailed!==1||original.summary.packageResult!=='fail'||original.summary.skipped||!original.summary.expectedStall||!original.summary.expectedWaitGraph)throw new Error('Original deadlock not reproduced')
    const file=path.join(source,'protocol/downloader/downloader.go');fs.writeFileSync(file,resetDownloaderPhase(fs.readFileSync(file)))
    const fixed=test('patched-package',['-count=1']),repeat=test('patched-repeat',['-count=10','-run','^'+regressionName+'$'])
    if(fixed.evidence.actualExit!==0||fixed.summary.passed!==10||fixed.summary.uniqueTests!==10||fixed.summary.regressionPassed!==1||fixed.summary.failed||fixed.summary.skipped||fixed.summary.packageResult!=='pass')throw new Error('Patched package refused')
    if(repeat.evidence.actualExit!==0||repeat.summary.passed!==10||repeat.summary.uniqueTests!==1||repeat.summary.regressionPassed!==10||repeat.summary.failed||repeat.summary.skipped||repeat.summary.packageResult!=='pass')throw new Error('Repeated patched control refused')
    report.results={baseline:baseline.summary,unpatched:original.summary,patched:fixed.summary,repeat:repeat.summary}
    report.status='PASS';save()
    fs.rmSync(work,{recursive:true});report.ownedWorkspaceRetained=false;save()
    console.log('Downloader phase control passed: original stalled at 5; patched package 10 tests and 10 controlled repeats passed; zero skips.')
  }catch{
    report.status='FAILURE';save()
    throw new Error('Downloader phase qualification refused; inspect its fixed-schema report')
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  qualify().catch(()=>{console.error('Downloader phase qualification failed; original evidence and owned workspace retained.');process.exitCode=1})
}
