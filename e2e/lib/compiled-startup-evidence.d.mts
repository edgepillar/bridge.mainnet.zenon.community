export function compiledStartupEvidence():{
 created(id:string,url:string):void
 handshake(id:string,status:number):void
 sent(id:string,data:string):void
 received(id:string,data:string):void
 failed(id:string):void
 closed(id:string):void
 report():{received:number;errors:number;invalid:number;open:boolean;frontierHeight:number|null;socketCount:number}
}
