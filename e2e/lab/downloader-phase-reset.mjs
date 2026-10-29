import crypto from 'node:crypto'

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
export const downloaderPhaseReset=Object.freeze({
  sourceCommit:'616f0a61ebc8562846965822f94976e531e0937c',
  sourceTree:'af654a9b7eb9ae81a1d76e5fea08b997beda0e9d',
  originalSha256:'2f5b1adf15958ba170d288831225b9a4156d57c9348676b321fbb755f2aaaa68',
  patchedSha256:'1a4ab891c4ced859adc249853f48f893a63ddfd90f886d2b6a6306c649e8d8b8',
})

// A byte-exact transform, never a best-effort patch against another Go version.
export function rewritePinnedSource(source,edit){
  if(!Buffer.isBuffer(source)||source.length>128*1024||!edit||
    !/^[0-9a-f]{64}$/.test(edit.beforeSha256??'')||!/^[0-9a-f]{64}$/.test(edit.afterSha256??'')||
    typeof edit.needle!=='string'||!edit.needle||typeof edit.replacement!=='string')throw new Error('Invalid pinned source transform')
  if(sha(source)!==edit.beforeSha256)throw new Error('Pinned source preimage mismatch')
  const text=source.toString('utf8'),parts=text.split(edit.needle)
  if(parts.length!==2)throw new Error('Pinned source anchor is not unique')
  const result=Buffer.from(parts[0]+edit.replacement+parts[1])
  if(result.length>128*1024||sha(result)!==edit.afterSha256)throw new Error('Pinned source result mismatch')
  return result
}

export function resetDownloaderPhase(source){
  const needle='\td.checks = make(map[types.Hash]*crossCheck)\n'
  return rewritePinnedSource(source,{
    beforeSha256:downloaderPhaseReset.originalSha256,afterSha256:downloaderPhaseReset.patchedSha256,needle,
    replacement:needle+'\t// Each completed synchronization owns its continuation signals.\n\td.processCh = make(chan bool, 1)\n',
  })
}
