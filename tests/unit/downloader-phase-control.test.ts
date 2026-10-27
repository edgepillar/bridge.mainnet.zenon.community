import { expect, it } from 'vitest'
import { summarizeGoTest } from '../../e2e/lab/downloader-phase-control.mjs'

const pkg='github.com/zenon-network/go-zenon/protocol/downloader',test='TestSynchroniseDoesNotReusePreviousHashCompletion'
const output=(rows:Record<string,unknown>[])=>Buffer.from(rows.map(row=>JSON.stringify({Package:pkg,...row})).join('\n')+'\n')

it('keeps real Go pass, failure and skip counts separate',()=>{
 expect(summarizeGoTest(output([{Action:'pass',Test:test},{Action:'skip',Test:'TestOther'},{Action:'pass'}]))).toMatchObject({passed:1,failed:0,skipped:1,regressionPassed:1,uniqueTests:2,packageResult:'pass'})
})
it('recognizes the exact expected deadlock while discarding raw diagnostic data',()=>{
 const result=summarizeGoTest(output([{Action:'output',Output:'PRIVATE_PATH PRIVATE_TOKEN\nnext synchronization stalled: height=5 pending=2 cached=0 active=1\nCONTROL_WAIT_GRAPH=HASH_COMPLETION_HANDOFF_WITHOUT_BLOCK_FETCHER'},{Action:'fail',Test:test},{Action:'fail'}]))
 expect(result).toMatchObject({failed:1,regressionFailed:1,packageResult:'fail',expectedStall:true,expectedWaitGraph:true})
 expect(JSON.stringify(result)).not.toMatch(/PRIVATE|height=|CONTROL_WAIT_GRAPH/)
})
it('refuses malformed, oversized and foreign package evidence with fixed errors',()=>{
 for(const data of [Buffer.from('PRIVATE_INVALID_JSON'),Buffer.alloc(8*1024*1024+1),output([{Action:'PRIVATE_ACTION'}]),output([{Package:'PRIVATE_PACKAGE',Action:'pass'}])])expect(()=>summarizeGoTest(data)).toThrow(/Invalid bounded Go test/)
})
