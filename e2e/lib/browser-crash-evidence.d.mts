export type ReaderProcess={state:'EXITED'|'SIGNALED'|'UNKNOWN';actualExit:number|null;signal:string|null;outputComplete:boolean}
export type OfflineCrashEvidence={status:'COMPLETE'|'UNAVAILABLE';reason?:string;reports?:unknown[];rawDumpPublished:false;otherAnnotationValuesRead?:false;readerProcess:ReaderProcess}
export function readOfflineCrashEvidence(directory:string):OfflineCrashEvidence
export function calibrationFailureFacts(error:unknown):{category:string;messageSha256:string;messageTruncated:boolean;protocolCode:number|null}
export function offlineCrashOptions(puppeteer:{defaultArgs():Promise<string[]>|string[]},directory:string):Promise<{ignoreDefaultArgs:string[];args:string[];env:Record<string,string|undefined>}>
export function offlineRendererDumpControlPassed(control:unknown):boolean
