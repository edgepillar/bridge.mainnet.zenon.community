import {expect,it} from 'vitest'
import crypto from 'node:crypto'
import {deflateRawSync} from 'node:zlib'
import {decodeReporterComponent,readPinnedReporterRange,verifyReporterPin,type ReporterPin} from '../../e2e/lib/reporter-component.mjs'

function fixture(){
 const payload=Buffer.alloc(128);Buffer.from([127,69,76,70,2,1]).copy(payload);payload.writeUInt16LE(62,18)
 const compressed=deflateRawSync(payload),sha=(b:Buffer)=>crypto.createHash('sha256').update(b).digest('hex')
 const pin:ReporterPin={schema:1,version:'155.0.8059.39',platform:'linux64',sourceUrl:'https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.39/linux64/chrome-linux64.zip',archiveBytes:1_000_000,archiveEtag:'"'+'0'.repeat(32)+'"',member:'chrome-linux64/chrome_crashpad_handler',rangeStart:1000,rangeEnd:999+compressed.length,compressedBytes:compressed.length,compressedSha256:sha(compressed),bytes:payload.length,sha256:sha(payload),browserSha256:'0'.repeat(64)}
 const response=(data=compressed,status=206,range=`bytes ${pin.rangeStart}-${pin.rangeEnd}/${pin.archiveBytes}`)=>new Response(Uint8Array.from(data),{status,headers:{'content-range':range,'content-length':String(pin.compressedBytes),etag:pin.archiveEtag}})
 return {payload,compressed,pin,response}
}
it('accepts only the exact range and both verified component identities',async()=>{
 const f=fixture(),raw=await readPinnedReporterRange(f.response(),f.pin)
 expect(decodeReporterComponent(raw,f.pin)).toEqual(f.payload)
})
it('refuses full-archive responses, a changed range and streamed excess bytes',async()=>{
 const f=fixture()
 await expect(readPinnedReporterRange(f.response(f.compressed,200),f.pin)).rejects.toThrow('RANGE_REFUSED')
 await expect(readPinnedReporterRange(f.response(f.compressed,206,'bytes 0-1/2'),f.pin)).rejects.toThrow('RANGE_REFUSED')
 await expect(readPinnedReporterRange(f.response(Buffer.concat([f.compressed,Buffer.from([0])])),f.pin)).rejects.toThrow('RANGE_BOUND')
})
it('refuses corrupt compressed bytes, a changed payload digest and expansion past the declared size',()=>{
 const f=fixture(),corrupt=Buffer.from(f.compressed);corrupt[0]^=1
 expect(()=>decodeReporterComponent(corrupt,f.pin)).toThrow()
 expect(()=>decodeReporterComponent(f.compressed,{...f.pin,sha256:'0'.repeat(64)})).toThrow()
 expect(()=>decodeReporterComponent(f.compressed,{...f.pin,bytes:f.pin.bytes-1})).toThrow()
})
it('refuses another origin, version, unbounded size and inconsistent range metadata',()=>{
 const {pin}=fixture()
 for(const changed of [{sourceUrl:'https://synthetic.invalid/component'},{version:'other'},{bytes:9*1024**2},{rangeEnd:pin.rangeEnd+1}])expect(()=>verifyReporterPin({...pin,...changed})).toThrow()
})
