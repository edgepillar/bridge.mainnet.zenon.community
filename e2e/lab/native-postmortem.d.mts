export type NativeNodeRole='rpc'|'pillar'|'pillar2'|'pillar3'|'observer'
export const nativePostmortemRoles:readonly NativeNodeRole[]
export interface PostmortemIdentity {head:string;tree:string;buildKey:string;binaryHash:string;goCommit:string;goTree:string;nodeRole:NativeNodeRole}
export interface PostmortemExit {status:string;challenge:string;identity:PostmortemIdentity;code:number|null;signal:string|null}
export function identityForPostmortem(options:{head:string;tree:string;build:{key:string;binaryHash:string;sourceCommit:string;sourceTree:string};nodeRole?:NativeNodeRole}):PostmortemIdentity
export function nodePostmortemDirectory(options:{directory:string;nodeRole:NativeNodeRole;create?:boolean}):string
export function ownedPostmortemController(options:{identity:PostmortemIdentity;challenge:string;signalRpc:()=>boolean}):{accept(raw:string|Buffer):boolean;exited(code:number|null,signal:string|null):PostmortemExit|null}
export function attachOwnedPostmortem(options:{directory:string;identity:PostmortemIdentity;signalRpc:()=>boolean}):Promise<{close():void;noteExit(code:number|null,signal:string|null):void}>
export function requestOwnedPostmortem(options:{directory:string;identity:PostmortemIdentity;timeoutMs?:number}):Promise<string>
export function requestOwnedNodePostmortem(options:{directory:string;nodeRole:NativeNodeRole;identity:PostmortemIdentity;timeoutMs?:number}):Promise<string>
