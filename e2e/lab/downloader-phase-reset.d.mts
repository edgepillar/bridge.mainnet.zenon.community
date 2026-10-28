export const downloaderPhaseReset: Readonly<{sourceCommit:string;sourceTree:string;originalSha256:string;patchedSha256:string}>
export function rewritePinnedSource(source:Buffer,edit:{beforeSha256:string;afterSha256:string;needle:string;replacement:string}):Buffer
export function resetDownloaderPhase(source:Buffer):Buffer
