import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true }) })
function diagnostic(scenario: string, mode?: string) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'bridge-frontier-cli-')); roots.push(root)
  for (const name of ['frontier.mjs', 'readiness.mjs', 'native-diagnostics.mjs', 'downloader-phase-reset.mjs']) fs.copyFileSync(fileURLToPath(new URL('../../e2e/lab/' + name, import.meta.url)), path.join(root, name))
  if(scenario==='producer-profile'){
    const identity=JSON.parse(spawnSync('git',['log','-1','--format={"head":"%H","tree":"%T"}'],{encoding:'utf8'}).stdout)
    const build={key:'3'.repeat(64),binaryHash:'4'.repeat(64),sourceCommit:'5'.repeat(40),sourceTree:'6'.repeat(40)}
    fs.mkdirSync(path.join(root,'.build/native'),{recursive:true})
    fs.writeFileSync(path.join(root,'verify-build.mjs'),'export const verifiedBuild=()=>('+JSON.stringify(build)+')')
    fs.writeFileSync(path.join(root,'.build/native/run-manifest.json'),JSON.stringify({buildKey:build.key,znndHash:build.binaryHash,sourceCommit:build.sourceCommit,sourceTree:build.sourceTree,bridgeSourceCommit:identity.head,bridgeSourceTree:identity.tree,diagnostics:{profileMode:'postmortem',profileHost:null,profilePort:null,rpcLogLevel:'error',coldCase:'error-b',postmortemRoles:['rpc','pillar','pillar2','pillar3','observer']}}))
    // Only the owner transport is synthetic; target selection and the CLI are real.
    fs.writeFileSync(path.join(root,'native-postmortem.mjs'),`import fs from 'node:fs';
      export const identityForPostmortem=value=>value;
      const capture=({nodeRole='rpc'})=>{fs.writeFileSync(new URL('./profile-target.json',import.meta.url),JSON.stringify({nodeRole}));return 'goroutine 987654321 [chan receive]:\\ngithub.com/zenon-network/go-zenon/protocol/downloader.(*Downloader).syncWithPeer(0x123, PRIVATE_ARGUMENT)\\n\\tPRIVATE_FILE.go:12 +0x12\\n\\n'};
      export const requestOwnedPostmortem=capture;export const requestOwnedNodePostmortem=capture;`)
  }
  // This is a fixture-only subprocess: no RPC listener, chain, wallet or real wait.
  fs.writeFileSync(path.join(root, 'fixture.mjs'), `
    let now=0, reads=0, diagnosticReads=0; const scenario=process.env.FRONTIER_FIXTURE;
    process.on('exit',()=>console.log('FIXTURE_DIAGNOSTIC_READS='+diagnosticReads));
    Date.now=()=>now;
    globalThis.setTimeout=(fn,ms,...args)=>{now+=ms;queueMicrotask(()=>fn(...args));return {unref(){}}};
    globalThis.fetch=async(input,options)=>{
      const url=new URL(input); if(url.hostname!=='127.0.0.1')throw Error('Unexpected fixture transport');
      const q=JSON.parse(options.body);let result;
      if(q.method.startsWith('stats.')||(q.method==='ledger.getMomentumsByHeight'&&q.params[0]===2))diagnosticReads++;
      if(q.method==='ledger.getFrontierMomentum'){
        reads++;const lagging=['isolated','early-fork'].includes(scenario)&&url.port==='47100';
        const height=scenario==='producer-profile'?(url.port==='47101'?3:41):['late-fork','connected-lag'].includes(scenario)?(url.port==='46997'?5:55):scenario==='invalid'?'22':['stalled','diag-unavailable','diag-oversize'].includes(scenario)?22:lagging?2:scenario==='moving'?(reads===1?2:22):(reads<=2?2:22);
        result={chainIdentifier:322,height};
      }else if(q.method==='ledger.getMomentumsByHeight'){
        if(scenario==='diag-unavailable'&&q.params[0]===2)throw Error('PRIVATE_ENDPOINT_AUTH');
        result={list:['isolated','early-fork'].includes(scenario)&&url.port==='47100'&&q.params[0]>2?[]:[{height:q.params[0],chainIdentifier:322,hash:((scenario==='divergent'&&url.port==='47103')||(scenario==='early-fork'&&url.port==='47100')||(scenario==='late-fork'&&url.port==='46997'&&q.params[0]===5)?'cd':'ab').repeat(32)}]};
      }else if(q.method==='stats.networkInfo'){
        if(scenario==='diag-unavailable')throw Error('PRIVATE_ENDPOINT_AUTH');
        result={numPeers:scenario==='isolated'&&url.port==='47100'?0:4,peers:[{ip:'PRIVATE_IP',publicKey:'PRIVATE_PEER_ID',name:'PRIVATE_NAME'}],self:{ip:'PRIVATE_SELF'}};
        if(scenario==='diag-oversize')result.extra='PRIVATE_PAYLOAD'.repeat(10000);
      }else if(q.method==='stats.syncInfo'){
        if(scenario==='diag-unavailable')throw Error('PRIVATE_ENDPOINT_AUTH');
        result={state:scenario==='isolated'&&url.port==='47100'?3:2,currentHeight:['isolated','early-fork'].includes(scenario)&&url.port==='47100'?2:22,targetHeight:22,extra:'PRIVATE_SYNC_DATA'};
      }else throw Error('Unexpected fixture method');
      return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}),{status:200});
    };
  `)
  const child = spawnSync(process.execPath, ['--import', path.join(root, 'fixture.mjs'), path.join(root, 'frontier.mjs'), '1', ...(mode ? ['--' + mode] : [])], {
    cwd: process.cwd(), env: { ...process.env, FRONTIER_FIXTURE: scenario, LAB_RPC: 'http://127.0.0.1:46997' }, encoding: 'utf8', timeout: 8000, maxBuffer: 256 * 1024,
  })
  const report = mode && path.join(root, '.build', mode, 'readiness-report.json')
  return { ...child, report: report && fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null, profileTarget:fs.existsSync(path.join(root,'profile-target.json'))?JSON.parse(fs.readFileSync(path.join(root,'profile-target.json'),'utf8')):null }
}
describe('actual readiness CLI exits with synthetic bounded transport', () => {
  it.each(['native', 'docker'])('accepts a cold initial diagnostic only after full %s convergence and subsequent production', (mode) => {
    const result = diagnostic('cold', mode)
    expect(result.status, result.stderr).toBe(0)
    expect(result.report).toMatchObject({ status: 'SUCCESS', initialHeight: 2, warmupHeight: 2, minimumHeight: 20, requiredSamples: 3 })
    expect(result.report.rounds.at(-1)).toMatchObject({ anchorHeight: 22, agreed: 3 })
    expect(result.stdout).toContain('fixture writes may begin')
    expect(result.stdout).toContain('FIXTURE_DIAGNOSTIC_READS=0')
  })
  it('refuses a converged chain that never advances from its original frontier', () => {
    const result = diagnostic('stalled', 'native')
    expect(result.status).toBe(1); expect(result.report.status).toBe('FAILURE')
    expect(result.stdout).not.toContain('fixture writes may begin')
  })
  it('refuses production when the five exact recent hashes disagree', () => {
    const result = diagnostic('divergent', 'docker')
    expect(result.status).toBe(1); expect(result.report.status).toBe('FAILURE')
    expect(result.report.rounds.every((r: any) => r.agreed === 0)).toBe(true)
  })
  it('retains the simple production diagnostic without lab-mode qualification', () => {
    expect(diagnostic('moving').status).toBe(0)
    expect(diagnostic('stalled').status).toBe(1)
  })
  it('rejects a malformed original frontier before reporting readiness', () => {
    const result = diagnostic('invalid', 'native')
    expect(result.status).toBe(1); expect(Boolean(result.report)).toBe(false); expect(result.stderr).toContain('frontier identity')
  })
  it('retains peer isolation evidence without accepting the four advancing nodes', () => {
    const result = diagnostic('isolated', 'native')
    expect(result.status).toBe(1); expect(result.report.status).toBe('FAILURE')
    expect(result.report.failureDiagnostics).toMatchObject({ status: 'COMPLETE', earlyHeight: 2, earlyHashesAgree: true })
    expect(result.report.failureDiagnostics.nodes.find((n: any) => n.port === 47100)).toMatchObject({ peerCount: 0, sync: { state: 3, currentHeight: 2 } })
    expect(result.stdout).not.toContain('fixture writes may begin')
  })
  it('distinguishes a connected early fork while excluding peer identities and raw fields', () => {
    const result = diagnostic('early-fork', 'native')
    expect(result.status).toBe(1); expect(result.report.failureDiagnostics.status).toBe('COMPLETE')
    expect(result.report.failureDiagnostics.earlyHashesAgree).toBe(false)
    expect(result.report.failureDiagnostics.nodes.every((n: any) => n.peerCount === 4)).toBe(true)
    expect(JSON.stringify(result.report)).not.toContain('PRIVATE_')
  })
  it('preserves the original refusal when diagnostic RPCs fail without exposing their errors', () => {
    const result = diagnostic('diag-unavailable', 'native')
    expect(result.status).toBe(1); expect(result.stderr).toContain('Lab nodes did not converge')
    expect(result.report.failureDiagnostics).toMatchObject({ status: 'PARTIAL', earlyHashesAgree: null })
    expect(result.report.failureDiagnostics.nodes.every((n: any) => n.unavailable.length === 3)).toBe(true)
    expect(result.stderr + JSON.stringify(result.report)).not.toContain('PRIVATE_')
  })
  it.each(['late-fork', 'connected-lag'])('distinguishes %s at the shared frontier even when height two agrees', (scenario) => {
    const result = diagnostic(scenario, 'native')
    expect(result.status).toBe(1)
    expect(result.report.failureDiagnostics).toMatchObject({ earlyHashesAgree: true, comparisonHeight: 5, commonHashesAgree: scenario === 'connected-lag' })
    expect(result.report.nativeFailure.status).toBe('OWNER_SCOPE_UNAVAILABLE')
    expect(result.stdout).not.toContain('fixture writes may begin')
  })
  it('bounds diagnostic transport bytes and reports unavailable data without changing readiness', () => {
    const result = diagnostic('diag-oversize', 'native')
    expect(result.status).toBe(1); expect(result.report.status).toBe('FAILURE')
    expect(result.report.failureDiagnostics.status).toBe('PARTIAL')
    expect(result.report.failureDiagnostics.nodes.every((n: any) => n.peerCount === null && n.unavailable.includes('NETWORK_INFO'))).toBe(true)
    expect(JSON.stringify(result.report)).not.toContain('PRIVATE_')
  })
  it('captures the lagging producer instead of the healthy RPC after preserving the refusal',()=>{
    const result=diagnostic('producer-profile','native')
    expect(result.status).toBe(1);expect(result.report.status).toBe('FAILURE')
    expect(result.profileTarget).toEqual({nodeRole:'pillar2'})
    expect(result.report.nativeFailure).toMatchObject({status:'CAPTURED',nodeRole:'pillar2',captureMode:'postmortem',target:{nodeRole:'pillar2',port:47101,frontierHeight:3}})
    expect(result.stdout).not.toContain('fixture writes may begin');expect(JSON.stringify(result.report)).not.toContain('PRIVATE_')
  })
})
