export type ReporterPin={schema:1;version:string;platform:string;sourceUrl:string;archiveBytes:number;archiveEtag:string;member:string;rangeStart:number;rangeEnd:number;compressedBytes:number;compressedSha256:string;bytes:number;sha256:string;browserSha256:string;crc32?:number;scope?:string}
export function verifyReporterPin(pin:unknown):ReporterPin
export function decodeReporterComponent(compressed:Buffer,pin:ReporterPin):Buffer
export function readPinnedReporterRange(response:Response,pin:ReporterPin):Promise<Buffer>
