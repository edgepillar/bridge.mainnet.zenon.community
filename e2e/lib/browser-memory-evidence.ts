import fs from 'node:fs'

const names=['low','high','max','oom','oom_kill','oom_group_kill'] as const
type Counts=Partial<Record<typeof names[number],number>>
type Sample={status:'COMPLETE';counts:Counts}|{status:'UNAVAILABLE';reason:'READ_FAILED'|'INVALID_SCHEMA'}

// These hierarchical counters cover the runner cgroup, not a particular PID.
// Read only at the two experiment boundaries; never retain a path or raw error.
export function browserMemoryEvidence(read:()=>string=()=>fs.readFileSync('/sys/fs/cgroup/memory.events','utf8')){
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
  report:()=>({scope:'CGROUP_ROOT_HIERARCHY' as const,attribution:'NOT_PROCESS_SPECIFIC' as const,baseline,sample:after,delta}),
 }
}
