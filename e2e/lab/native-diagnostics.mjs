// Fixed-schema facts only. Raw logs and profiles can contain peer data, paths
// and pointer arguments and must never enter qualification artifacts.
const sha=/^[0-9a-f]{40}$/
const digest=/^[0-9a-f]{64}$/
const object=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{}
const natural=n=>Number.isSafeInteger(n)&&n>=0
const messages=new Map([
  ['looking for common ancestor','ANCESTOR_SEARCH'],['common ancestor','ANCESTOR_FOUND'],
  ['Block synchronisation started','SYNC_STARTED'],['Synchronization completed','SYNC_REPORTED_COMPLETE'],
  ['Block import failed','IMPORT_FAILED'],['start inserting chain','INSERT_STARTED'],
  ['head hash set outside requested range','HASH_RANGE_REJECTED'],['head hash timeout','HASH_TIMEOUT'],
  ['search hash timeout','HASH_TIMEOUT'],['hash request timed out','HASH_TIMEOUT'],
  ['Block delivery timeout','BLOCK_TIMEOUT'],['Block fetching completed','FETCH_COMPLETED'],
  ['Removing peer','PEER_REMOVED'],['message handling failed','PROTOCOL_FAILED'],
  ['side-chain replacement failed, restoring original branch','RESTORE_STARTED'],
  ["can't link momentums to insert",'CHAIN_LINK_FAILED'],
])
export function summarizeSyncLog(text){
  if(Buffer.byteLength(text)>256*1024)throw new Error('Native sync log bound exceeded')
  const counts={},events=[];let truncated=false
  for(const line of text.split('\n')){
    if(line.length>4096){truncated=true;continue}
    const field=line.match(/(?:^|\s)msg=("(?:[^"\\]|\\.)*"|\S+)/);if(!field)continue
    let message;try{message=field[1][0]==='"'?JSON.parse(field[1]):field[1]}catch{continue}
    const kind=messages.get(message);if(!kind)continue
    counts[kind]=(counts[kind]??0)+1
    const event={kind}
    for(const [key,label] of [['number','ancestorHeight'],['momentum-height','failedHeight'],['num-momentums','momentumCount']]){
      const value=line.match(new RegExp('(?:^|\\s)'+key+'=(\\d+)(?:\\s|$)'));if(value&&natural(Number(value[1])))event[label]=Number(value[1])
    }
    if(/won't insert side-chain which is not longer/.test(line))event.reason='SIDE_CHAIN_NOT_LONGER'
    else if(/can't link momentums|No momentum at height/.test(line))event.reason='CHAIN_LINK'
    else if(/producer|Producer/.test(line)&&kind==='IMPORT_FAILED')event.reason='PRODUCER'
    else if(/cache|Cache/.test(line)&&kind==='IMPORT_FAILED')event.reason='CACHE'
    else if(/timeout|timed out/.test(line))event.reason='TIMEOUT'
    else if(kind==='IMPORT_FAILED')event.reason='OTHER'
    events.push(event);if(events.length>32)events.shift()
  }
  return {counts,events,truncated}
}
export function summarizeGoroutines(text){
  if(Buffer.byteLength(text)>2*1024*1024)throw new Error('Native profile bound exceeded')
  const groups=new Map();let observed=0,truncated=false
  for(const block of text.split(/\n\n/)){
    const header=block.match(/^goroutine \d+(?: [^\n[\]]{1,160})? \[([^\]\n]{1,160})\]:/);if(!header)continue
    if(++observed>2048){truncated=true;break}
    const state=/semacquire|Mutex\.(?:R?Lock)/.test(header[1])?'LOCK_WAIT':/chan send/.test(header[1])?'CHANNEL_SEND':/chan receive/.test(header[1])?'CHANNEL_RECEIVE':/IO wait/.test(header[1])?'IO_WAIT':/^select/.test(header[1])?'SELECT':/^running/.test(header[1])?'RUNNING':/^runnable/.test(header[1])?'RUNNABLE':/^sleep/.test(header[1])?'SLEEP':'OTHER'
    const frames=[]
    for(const line of block.split('\n').slice(1)){
      const at=line.lastIndexOf('(');if(at<0)continue;const frame=line.slice(0,at)
      if(frame.length<=180&&/^(?:github\.com\/zenon-network\/go-zenon\/[A-Za-z0-9_./-]+\.(?:\(\*?[A-Za-z0-9_]+\)\.)?[A-Za-z0-9_.$]+|(?:runtime|sync|internal\/sync)\.(?:\(\*?[A-Za-z0-9_]+\)\.)?[A-Za-z0-9_.$]+)$/.test(frame)){
        if(frames.length<24)frames.push(frame);else truncated=true
      }
    }
    if(!frames.some(x=>x.startsWith('github.com/zenon-network/go-zenon/')))continue
    const key=JSON.stringify({state,frames});if(!groups.has(key)){if(groups.size>=64){truncated=true;continue}groups.set(key,{state,frames,count:0})}groups.get(key).count++
  }
  return {status:observed?'CAPTURED':'UNAVAILABLE',observed,groups:[...groups.values()],truncated}
}
export async function collectNativeFailureFacts({runtime,build,head,tree,readProfile,readLogs}){
  const r=object(runtime),b=object(build),d=object(r.diagnostics)
  const mode=d.profileMode??'loopback',profileOwner=mode==='loopback'?d.profileHost==='127.0.0.1'&&d.profilePort===47210:mode==='postmortem'&&d.profileHost===null&&d.profilePort===null
  if(!sha.test(head??'')||!sha.test(tree??'')||!digest.test(b.key??'')||!digest.test(b.binaryHash??'')||!sha.test(b.sourceCommit??'')||!sha.test(b.sourceTree??'')||r.bridgeSourceCommit!==head||r.bridgeSourceTree!==tree||r.buildKey!==b.key||r.znndHash!==b.binaryHash||r.sourceCommit!==b.sourceCommit||r.sourceTree!==b.sourceTree||!profileOwner||!['error','info'].includes(d.rpcLogLevel))return {status:'OWNER_SCOPE_UNAVAILABLE'}
  let profile={status:'UNAVAILABLE'},logs={status:'UNAVAILABLE'}
  try{profile=summarizeGoroutines(await readProfile())}catch{/* Unavailable is not evidence of a healthy importer. */}
  try{logs=await readLogs()}catch{/* No raw filesystem or peer error is retained. */}
  return {status:profile.status==='CAPTURED'?'CAPTURED':'PARTIAL',profileMode:mode,rpcLogLevel:d.rpcLogLevel,coldCase:['error-a','error-b','info'].includes(d.coldCase)?d.coldCase:'manual',profile,logs}
}
