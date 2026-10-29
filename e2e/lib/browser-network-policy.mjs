// Owned loopback qualification only. No Fetch interception or public endpoints.
function origins(values){
 if(!Array.isArray(values)||!values.length||values.length>8||new Set(values).size!==values.length)throw Error('Fixture origins refused')
 return values.map(value=>{
  let url;try{url=new URL(value)}catch{throw Error('Fixture origin refused')}
  if(typeof value!=='string'||url.origin!==value||url.hostname!=='127.0.0.1'||!['http:','ws:'].includes(url.protocol)||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Fixture origin refused')
  return value
 })
}
export function directNetworkPolicy(values){
 return {urlPatterns:[...origins(values).map(origin=>({urlPattern:origin+'/*',block:false})),{urlPattern:'data:*',block:false}],urls:['*']}
}
export function fixtureConnectPolicy(values){return 'connect-src '+origins(values).join(' ')}
export function fixtureRequestAllowed(raw,values){
 const allowed=origins(values)
 try{const url=new URL(raw);return !url.username&&!url.password&&(url.protocol==='data:'||allowed.includes(url.origin))}catch{return false}
}
