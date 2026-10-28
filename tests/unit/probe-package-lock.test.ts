import {expect,it} from 'vitest'
import {verifyProbePackage} from '../../e2e/lib/probe-package-lock.mjs'

it('qualifies a locked nested transport independently of the other hoisted version',()=>{
 const packages={'node_modules/puppeteer-core/node_modules/ws':{version:'8.22.0'},'node_modules/ws':{version:'8.21.0'}}
 const nested='node_modules/puppeteer-core/node_modules/ws',hoisted='node_modules/ws'
 expect(packages[nested].version).not.toBe(packages[hoisted].version)
 expect(verifyProbePackage(packages,nested,packages[nested].version)).toEqual({packagePath:nested,version:packages[nested].version})
 expect(()=>verifyProbePackage(packages,hoisted,packages[nested].version)).toThrow()
})
it('does not substitute another package or accept a mismatched resolved version',()=>{
 const packages={'node_modules/a':{version:'1.0.0'},'node_modules/a/node_modules/b':{version:'2.0.0'}}
 expect(()=>verifyProbePackage(packages,'node_modules/b','2.0.0')).toThrow()
 expect(()=>verifyProbePackage(packages,'node_modules/a/node_modules/b','1.0.0')).toThrow()
})
it('refuses paths outside the installed dependency tree without retaining them',()=>{
 for(const packagePath of ['../PRIVATE_PATH','/PRIVATE_PATH','node_modules/../PRIVATE_PATH','node_modules/./a','node_modules/a/']){
  expect(()=>verifyProbePackage({},packagePath,'1.0.0')).toThrow('Resolved probe dependency differs from the lock')
 }
})
