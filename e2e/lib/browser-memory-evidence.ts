import fs from 'node:fs'
import path from 'node:path'

const names=['low','high','max','oom','oom_kill','oom_group_kill'] as const
type Counts=Partial<Record<typeof names[number],number>>
type Sample={status:'COMPLETE';counts:Counts}|{status:'UNAVAILABLE';reason:'READ_FAILED'|'INVALID_SCHEMA'}

export function readCurrentCgroupMemory(readFile:(file:string)=>string=file=>fs.readFileSync(file,'utf8')){
 const membership=readFile('/proc/self/cgroup')
 if(Buffer.byteLength(membership)>4096)throw Error('Cgroup membership refused')
 const matches=[...membership.matchAll(/^0::(\/[^\0\r\n]*)$/gm)]
 if(matches.length!==1||matches[0][1].split('/').some(part=>part==='.'||part==='..'))throw Error('Cgroup membership refused')
 // Keep the discovered path private. Root cgroups may have no memory.events;
 // the process's inherited cgroup is the relevant controller when available.
 return readFile(path.join('/sys/fs/cgroup',matches[0][1].slice(1),'memory.events'))
}

// These hierarchical counters cover the process cgroup, not a particular PID.
// Read only at the two experiment boundaries; never retain a path or raw error.
export function browserMemoryEvidence(read:()=>string=()=>readCurrentCgroupMemory()){
 const sample=():Sample=>{
  let text:string
  try{text=read()}catch{return {status:'UNAVAILABLE',reason:'READ_FAILED'}}
  if(typeof text!=='string'||Buffer.byteLength(text)>4096)return {status:'UNAVAILABLE',reason:'INVALID_SCHEMA'}
  const counts:Counts={}
  for(const line of text.trim().split('\n')){
   const match=/^([a-z_]+) ([0-9]+)$/.exec(line)
   if(!match)return {status:'UNAVAILABLE',reason:'INVALID_SCHEMA'}
   if(!names.includes(match[1] as typeof names[number]))continue
   const name=match[1] as typeof names[number],value=Number(match[2])
   if(Object.hasOwn(counts,name)||!Number.isSafeInteger(value))return {status:'UNAVAILABLE',reason:'INVALID_SCHEMA'}
   counts[name]=value
  }
  if(counts.oom===undefined||counts.oom_kill===undefined)return {status:'UNAVAILABLE',reason:'INVALID_SCHEMA'}
  return {status:'COMPLETE',counts}
 }
 const baseline=sample();let after:Sample|null=null,delta:Counts|null=null
 return {
  captureAfterFailure(){
   if(after!==null)return
   after=sample()
   if(baseline.status==='COMPLETE'&&after.status==='COMPLETE'){
    const difference:Counts={}
    for(const name of names){
     const before=baseline.counts[name],current=after.counts[name]
     if(before!==undefined&&current!==undefined){if(current<before)return;difference[name]=current-before}
    }
    delta=difference
   }
  },
  report:()=>({scope:'CURRENT_PROCESS_CGROUP_HIERARCHY' as const,attribution:'NOT_PROCESS_SPECIFIC' as const,baseline,sample:after,delta}),
 }
}
