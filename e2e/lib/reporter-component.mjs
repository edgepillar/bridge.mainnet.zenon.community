// One pinned public archive member; bounded transport and exact payload hashes.
import crypto from 'node:crypto'
import {inflateRawSync} from 'node:zlib'
const digest=data=>crypto.createHash('sha256').update(data).digest('hex')
export function verifyReporterPin(pin){
 if(pin?.schema!==1||pin.version!=='155.0.8059.39'||pin.platform!=='linux64'||pin.sourceUrl!==`https://storage.googleapis.com/chrome-for-testing-public/${pin.version}/linux64/chrome-linux64.zip`||pin.member!=='chrome-linux64/chrome_crashpad_handler')throw Error('REPORTER_PIN_REFUSED')
 for(const n of ['archiveBytes','rangeStart','rangeEnd','compressedBytes','bytes'])if(!Number.isSafeInteger(pin[n])||pin[n]<=0)throw Error('REPORTER_PIN_REFUSED')
 if(pin.archiveBytes>512*1024**2||pin.compressedBytes>4*1024**2||pin.bytes>8*1024**2||pin.rangeEnd!==pin.rangeStart+pin.compressedBytes-1||pin.rangeEnd>=pin.archiveBytes||!/^"[a-f0-9]{32}"$/.test(pin.archiveEtag))throw Error('REPORTER_PIN_REFUSED')
 for(const name of ['sha256','compressedSha256','browserSha256'])if(!/^[a-f0-9]{64}$/.test(pin[name]))throw Error('REPORTER_PIN_REFUSED')
 return pin
}
export function decodeReporterComponent(compressed,pin){
 verifyReporterPin(pin)
 if(compressed.length!==pin.compressedBytes||digest(compressed)!==pin.compressedSha256)throw Error('REPORTER_COMPRESSED_IDENTITY_REFUSED')
 const payload=inflateRawSync(compressed,{maxOutputLength:pin.bytes})
 if(payload.length!==pin.bytes||digest(payload)!==pin.sha256||payload.length<20||!payload.subarray(0,6).equals(Buffer.from([127,69,76,70,2,1]))||payload.readUInt16LE(18)!==62)throw Error('REPORTER_PAYLOAD_IDENTITY_REFUSED')
 return payload
}
export async function readPinnedReporterRange(response,pin){
 verifyReporterPin(pin)
 let reader,complete=false
 try{
  if(response.status!==206||response.headers.get('content-range')!==`bytes ${pin.rangeStart}-${pin.rangeEnd}/${pin.archiveBytes}`||response.headers.get('content-length')!==String(pin.compressedBytes)||response.headers.get('etag')!==pin.archiveEtag||![null,'identity'].includes(response.headers.get('content-encoding')))throw Error('REPORTER_RANGE_REFUSED')
  if(!response.body)throw Error('REPORTER_RANGE_REFUSED')
  reader=response.body.getReader();const chunks=[];let size=0
  for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>pin.compressedBytes)throw Error('REPORTER_RANGE_BOUND');chunks.push(Buffer.from(part.value))}
  if(size!==pin.compressedBytes)throw Error('REPORTER_RANGE_INCOMPLETE')
  complete=true
  return Buffer.concat(chunks,size)
 }finally{
  if(!complete){if(reader)await reader.cancel().catch(()=>{});else await response.body?.cancel().catch(()=>{})}
  reader?.releaseLock()
 }
}
