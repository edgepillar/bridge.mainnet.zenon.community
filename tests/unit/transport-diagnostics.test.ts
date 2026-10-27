import { expect, it } from 'vitest'
import { summarizeNetLog, summarizeNativeLog } from '../../e2e/lib/transport-diagnostics.ts'

const endpoint='ws://127.0.0.1:46998/'
const source=(id:number,type=1)=>({id,type})
const fixture=()=>({constants:{logSourceType:{URL_REQUEST:1,SOCKET:10,HTTP_STREAM_JOB:17},logEventTypes:{REQUEST_ALIVE:1,HTTP_STREAM_REQUEST_BOUND_TO_JOB:2,SOCKET_POOL_BOUND_TO_SOCKET:3,SOCKET_READ_ERROR:4,WEBSOCKET_RECV_FRAME_HEADER:5,WEBSOCKET_INVALID_FRAME:6}},events:[
  {type:1,source:source(1),params:{url:endpoint,headers:['Authorization: PRIVATE_HEADER']}},
  {type:2,source:source(1),params:{source_dependency:source(2,17)}},
  {type:3,source:source(2,17),params:{source_dependency:source(3,10)}},
]})

it('pairs transport errors only through the expected WebSocket dependency graph',()=>{
  const f=fixture();f.events.push({type:4,source:source(3,10),params:{net_error:-100}} as any,{type:4,source:source(99,10),params:{net_error:-101}} as any)
  const r=summarizeNetLog(f);expect(r.connections[0].errors).toEqual([{event:'SOCKET_READ_ERROR',code:-100}]);expect(JSON.stringify(r)).not.toContain('PRIVATE_HEADER')
})

it('retains protocol flags and fixed failure categories without headers, URLs or frame contents',()=>{
  const f=fixture();f.events.push({type:5,source:source(1),params:{masked:true,opcode:1,payload_length:1,PRIVATE_FRAME:'SECRET'}} as any,
    {type:6,source:source(1),params:{code:1002,internal_reason:'A server must not mask any frames that it sends to the client. PRIVATE_PEER'}} as any)
  const r=summarizeNetLog(f);expect(r.connections[0].invalidFrames).toEqual([{closeCode:1002,failureClass:'MASKED_SERVER_FRAME'}]);expect(r.connections[0].lastReceivedFrames).toEqual([{masked:true,opcode:1,payload_length:1}])
  expect(JSON.stringify(r)).not.toMatch(/PRIVATE|SECRET|ws:\/\//)
})

it('distinguishes successful upgrade cancellation and bounds incomplete diagnostics',()=>{
  const f=fixture();for(const code of [-173,-3])f.events.push({type:4,source:source(3,10),params:{net_error:code}} as any)
  expect(summarizeNetLog(f).connections[0].errors).toEqual([])
  for(let i=0;i<20;i++)f.events.push({type:4,source:source(3,10),params:{net_error:-100}} as any)
  expect(summarizeNetLog(f).connections[0].truncated).toBe(true);expect(summarizeNetLog(f).connections[0].errors).toHaveLength(16)
  expect(summarizeNetLog(f).status).toBe('INCOMPLETE')
  expect(()=>summarizeNetLog({})).toThrow();expect(()=>summarizeNetLog(f,'wss://private.fixture.invalid')).toThrow()
})

it('extracts public native call sites and failure categories without paths, arguments or raw logs',()=>{
  const r=summarizeNativeLog('panic: PRIVATE_VALUE\ngithub.com/zenon-network/go-zenon/rpc/server.(*handler).run(0x123, PRIVATE_ARGUMENT)\n/Users/private/secret.go:12\nwrite: broken pipe\nAuthorization: PRIVATE_HEADER')
  expect(r).toEqual({panic:true,categories:['BROKEN_PIPE'],frames:['github.com/zenon-network/go-zenon/rpc/server.(*handler).run']})
  expect(JSON.stringify(r)).not.toMatch(/PRIVATE|Users|0x123|Authorization/)
})
