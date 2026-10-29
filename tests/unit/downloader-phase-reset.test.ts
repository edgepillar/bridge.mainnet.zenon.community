import crypto from 'node:crypto'
import { expect, it } from 'vitest'
import { downloaderPhaseReset, resetDownloaderPhase, rewritePinnedSource } from '../../e2e/lab/downloader-phase-reset.mjs'

const sha=(bytes:Buffer)=>crypto.createHash('sha256').update(bytes).digest('hex')
const source=Buffer.from('before\nreset queue\nafter\n'),expected=Buffer.from('before\nreset queue\nreset phase\nafter\n')
const edit={beforeSha256:sha(source),afterSha256:sha(expected),needle:'reset queue\n',replacement:'reset queue\nreset phase\n'}

it('rewrites one exact source preimage into the exact qualified result without mutating the input',()=>{
 const original=Buffer.from(source)
 expect(rewritePinnedSource(source,edit)).toEqual(expected)
 expect(source).toEqual(original)
})
it('rejects changed, already-applied and incorrectly pinned source bytes',()=>{
 for(const input of [Buffer.from('changed'),expected])expect(()=>rewritePinnedSource(input,edit)).toThrow('preimage')
 expect(()=>rewritePinnedSource(source,{...edit,beforeSha256:'0'.repeat(64)})).toThrow('preimage')
 expect(()=>rewritePinnedSource(source,{...edit,afterSha256:'0'.repeat(64)})).toThrow('result')
})
it('rejects missing and repeated anchors even when the input checksum is known',()=>{
 expect(()=>rewritePinnedSource(source,{...edit,needle:'absent'})).toThrow('unique')
 const repeated=Buffer.concat([source,source])
 expect(()=>rewritePinnedSource(repeated,{...edit,beforeSha256:sha(repeated)})).toThrow('unique')
})
it('bounds inputs and reports only fixed errors for malformed or private data',()=>{
 for(const input of [Buffer.alloc(128*1024+1),null,'PRIVATE_SOURCE']){
  expect(()=>rewritePinnedSource(input as Buffer,edit)).toThrow('Invalid pinned source transform')
 }
 for(const changed of [{...edit,needle:''},{...edit,beforeSha256:'PRIVATE_VALUE'},{...edit,replacement:null}]){
  expect(()=>rewritePinnedSource(source,changed as typeof edit)).toThrow('Invalid pinned source transform')
 }
})
it('keeps the production wrapper fixed to the independently tested Go source and result',()=>{
 expect(Object.isFrozen(downloaderPhaseReset)).toBe(true)
 expect(downloaderPhaseReset).toEqual({sourceCommit:'616f0a61ebc8562846965822f94976e531e0937c',sourceTree:'af654a9b7eb9ae81a1d76e5fea08b997beda0e9d',originalSha256:'2f5b1adf15958ba170d288831225b9a4156d57c9348676b321fbb755f2aaaa68',patchedSha256:'1a4ab891c4ced859adc249853f48f893a63ddfd90f886d2b6a6306c649e8d8b8'})
 expect(()=>resetDownloaderPhase(source)).toThrow('preimage')
})
