export type DirectNetworkPolicy={urlPatterns:{urlPattern:string;block:boolean}[];urls:string[]}
export function directNetworkPolicy(origins:string[]):DirectNetworkPolicy
export function fixtureConnectPolicy(origins:string[]):string
export function fixtureRequestAllowed(url:string,origins:string[]):boolean
