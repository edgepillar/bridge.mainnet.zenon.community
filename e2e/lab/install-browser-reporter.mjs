// CI-only reporter input. Never replaces the pinned browser executable.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {decodeReporterComponent,readPinnedReporterRange,verifyReporterPin} from '../lib/reporter-component.mjs'
if(process.platform!=='linux'||process.env.GITHUB_ACTIONS!=='true')throw Error('REPORTER_CI_SCOPE_REFUSED')
const pin=verifyReporterPin(JSON.parse(fs.readFileSync(new URL('./browser-reporter.pin.json',import.meta.url))))
const browser=process.env.CHROME_PATH
if(!browser||!path.isAbsolute(browser))throw Error('REPORTER_BROWSER_REFUSED')
const parent=path.dirname(browser),info=fs.lstatSync(browser),folder=fs.lstatSync(parent)
if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||!folder.isDirectory()||folder.isSymbolicLink())throw Error('REPORTER_BROWSER_REFUSED')
const shaFile=file=>{const fd=fs.openSync(file,'r'),h=crypto.createHash('sha256'),buffer=Buffer.alloc(128*1024);try{for(;;){const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;h.update(buffer.subarray(0,n))}}finally{fs.closeSync(fd)}return h.digest('hex')}
if(shaFile(browser)!==pin.browserSha256)throw Error('REPORTER_BROWSER_IDENTITY_REFUSED')
const free=fs.statfsSync(parent)
if(free.bavail*free.bsize<10*1024**3+32*1024**2)throw Error('REPORTER_STORAGE_RESERVATION_REFUSED')
const destination=path.join(parent,'chrome_crashpad_handler');let transported=false
if(fs.existsSync(destination)){
 const st=fs.lstatSync(destination)
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size!==pin.bytes||shaFile(destination)!==pin.sha256)throw Error('REPORTER_EXISTING_FILE_REFUSED')
}else{
 const response=await fetch(pin.sourceUrl,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{Range:`bytes=${pin.rangeStart}-${pin.rangeEnd}`,'If-Match':pin.archiveEtag,'Accept-Encoding':'identity'}})
 const raw=await readPinnedReporterRange(response,pin),payload=decodeReporterComponent(raw,pin)
 fs.writeFileSync(destination,payload,{flag:'wx',mode:0o755});transported=true
}
if(shaFile(destination)!==pin.sha256||shaFile(browser)!==pin.browserSha256)throw Error('REPORTER_FINAL_IDENTITY_REFUSED')
fs.mkdirSync('.lab-tools',{recursive:true})
fs.writeFileSync('.lab-tools/browser-reporter-manifest.json',JSON.stringify({...pin,transported,fullArchiveDownloaded:false,browserExecutableReplaced:false,rawDumpPublished:false},null,2)+'\n',{flag:'wx'})
console.log('Pinned offline reporter component verified; browser identity preserved.')
