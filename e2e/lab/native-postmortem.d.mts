export interface PostmortemIdentity {head:string;tree:string;buildKey:string;binaryHash:string;goCommit:string;goTree:string}
export interface PostmortemExit {status:string;challenge:string;identity:PostmortemIdentity;code:number|null;signal:string|null}
export function identityForPostmortem(options:{head:string;tree:string;build:{key:string;binaryHash:string;sourceCommit:string;sourceTree:string}}):PostmortemIdentity
export function ownedPostmortemController(options:{identity:PostmortemIdentity;challenge:string;signalRpc:()=>boolean}):{accept(raw:string|Buffer):boolean;exited(code:number|null,signal:string|null):PostmortemExit|null}
export function attachOwnedPostmortem(options:{directory:string;identity:PostmortemIdentity;signalRpc:()=>boolean}):Promise<{close():void;noteExit(code:number|null,signal:string|null):void}>
export function requestOwnedPostmortem(options:{directory:string;identity:PostmortemIdentity;timeoutMs?:number}):Promise<string>
