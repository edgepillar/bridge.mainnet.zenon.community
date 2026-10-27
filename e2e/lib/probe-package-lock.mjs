// Node may resolve a nested dependency even when another version is hoisted.
// Verify the exact resolved package entry instead of selecting by package name.
export function verifyProbePackage(packages,packagePath,actualVersion){
 if(typeof packagePath!=='string'||!/^node_modules\/(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+$/.test(packagePath)||packagePath.split('/').some(x=>x==='.'||x==='..')||typeof actualVersion!=='string'||packages?.[packagePath]?.version!==actualVersion)throw Error('Resolved probe dependency differs from the lock')
 return {packagePath,version:actualVersion}
}
