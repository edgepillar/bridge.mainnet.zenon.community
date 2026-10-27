// The pinned Chromium host records utility-process termination categories in
// these histograms. Counters cover all utilities; they do not identify a PID or
// by themselves prove why the network service exited.
const revisionPin='@3ff7ac5a9224be9156d7f8703a06e22890aafd34'
const names={'ChildProcess.Crashed2':'crashed','ChildProcess.Killed2':'killed','ChildProcess.DisconnectedAlive2':'disconnectedAlive'} as const
type Counts={crashed:number;killed:number;disconnectedAlive:number}
type Sample={status:'COMPLETE';counts:Counts}|{status:'UNAVAILABLE';reason:string}

export async function browserTerminationEvidence(query:()=>Promise<unknown>,revision:string|null,timeoutMs=2000){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2000)throw new Error('Invalid diagnostic deadline')
 const read=async():Promise<Sample>=>{
  if(revision!==revisionPin)return {status:'UNAVAILABLE',reason:'SOURCE_REVISION'}
  let timer:ReturnType<typeof setTimeout>|undefined
  try{
   const result=await Promise.race([query().then(value=>({value}),()=>({failure:'QUERY_FAILED'})),new Promise<{failure:string}>(resolve=>{timer=setTimeout(()=>resolve({failure:'DEADLINE'}),timeoutMs)})])
   if('failure'in result)return {status:'UNAVAILABLE',reason:result.failure}
   const rows=(result.value as {histograms?:unknown}|null)?.histograms
   if(!Array.isArray(rows)||rows.length>128)throw new Error()
   const counts:Counts={crashed:0,killed:0,disconnectedAlive:0},seen=new Set<string>()
   for(const row of rows){
    if(!row||typeof row.name!=='string')throw new Error()
    if(!Object.hasOwn(names,row.name))continue
    if(seen.has(row.name)||!Array.isArray(row.buckets)||row.buckets.length>64)throw new Error()
    seen.add(row.name)
    let previous=-Infinity
    for(const bucket of row.buckets){
     if(![bucket.low,bucket.high,bucket.count].every(Number.isSafeInteger)||bucket.low>=bucket.high||bucket.low<previous||bucket.count<0)throw new Error()
     previous=bucket.high
     // PROCESS_TYPE_UTILITY is 6 in this exact Chromium revision.
     if(bucket.low<=6&&6<bucket.high)counts[names[row.name as keyof typeof names]]=bucket.count
    }
   }
   return {status:'COMPLETE',counts}
  }catch{return {status:'UNAVAILABLE',reason:'INVALID_SCHEMA'}}
  finally{if(timer!==undefined)clearTimeout(timer)}
 }
 const baseline=await read()
 let failedSockets=0,truncated=false,captured=false,sample:Sample|null=null,delta:Counts|null=null
 return {
  markFailure(){if(failedSockets<8)failedSockets++;else truncated=true},
  async captureAfterFailures(){
   if(!failedSockets||captured)return
   captured=true;sample=await read()
   if(baseline.status==='COMPLETE'&&sample.status==='COMPLETE'){
    const difference={crashed:sample.counts.crashed-baseline.counts.crashed,killed:sample.counts.killed-baseline.counts.killed,disconnectedAlive:sample.counts.disconnectedAlive-baseline.counts.disconnectedAlive}
    if(Object.values(difference).every(value=>value>=0))delta=difference
   }
  },
  report:()=>({mode:'FAILURE_TRIGGERED_PRE_TEARDOWN' as const,scope:'ALL_UTILITY_PROCESSES' as const,baseline,failedSockets,sample,delta,truncated}),
 }
}
