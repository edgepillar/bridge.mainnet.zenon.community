export function probeLedgerRound(endpoint:string):Promise<{received:number;errors:number;invalid:number;open:boolean;frontierHeight:number|null}>
