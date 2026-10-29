import {expect,it} from 'vitest'
import {directNetworkPolicy,fixtureConnectPolicy,fixtureRequestAllowed} from '../../e2e/lib/browser-network-policy.mjs'
const allowed=['http://127.0.0.1:5195','ws://127.0.0.1:46998']
it('allows exact owned origins before a default block without Fetch interception',()=>{
 const policy=directNetworkPolicy(allowed)
 expect(policy.urls).toEqual(['*'])
 expect(policy.urlPatterns).toEqual([{urlPattern:'http://127.0.0.1:5195/*',block:false},{urlPattern:'ws://127.0.0.1:46998/*',block:false},{urlPattern:'data:*',block:false}])
})
it('rejects external, wildcard, credentialed and noncanonical policy origins',()=>{
 for(const value of ['https://example.invalid','http://127.0.0.1:*','http://user@127.0.0.1:5195','http://127.0.0.1:5195/','http://127.0.0.1:5195/?x','http://localhost:5195','file:///owned-fixture'])expect(()=>directNetworkPolicy([value])).toThrow()
})
it('refuses empty, duplicate and unbounded policy origin sets',()=>{
 expect(()=>directNetworkPolicy([])).toThrow();expect(()=>directNetworkPolicy([allowed[0],allowed[0]])).toThrow()
 expect(()=>directNetworkPolicy(Array.from({length:9},(_,i)=>'http://127.0.0.1:'+(5200+i)))).toThrow()
})
it('keeps the fixture connect header confined to the validated origins',()=>{
 expect(fixtureConnectPolicy(allowed)).toBe('connect-src http://127.0.0.1:5195 ws://127.0.0.1:46998')
 expect(()=>fixtureConnectPolicy(['http://127.0.0.1:5195; connect-src *'])).toThrow()
})
it('admits normal owned paths and inline data without widening the host or port',()=>{
 for(const value of ['http://127.0.0.1:5195/assets/app.js?x=1','ws://127.0.0.1:46998/','data:image/png;base64,AA=='])expect(fixtureRequestAllowed(value,allowed)).toBe(true)
 for(const value of ['http://127.0.0.1:5196/','https://127.0.0.1:5195/','http://127.0.0.1.invalid:5195/','http://user@127.0.0.1:5195/','javascript:alert(1)','not a URL'])expect(fixtureRequestAllowed(value,allowed)).toBe(false)
})
