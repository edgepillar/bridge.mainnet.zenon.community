export function summarizeSyncLog(text: string): Record<string, any>
export function summarizeGoroutines(text: string): Record<string, any>
export function nativeFailureTarget(nodes: unknown): {nodeRole:'rpc'|'pillar'|'pillar2'|'pillar3'|'observer';port:number;frontierHeight:number}|null
export function collectNativeFailureFacts(input: {
  runtime: unknown; build: unknown; head: string; tree: string;
  nodeRole?:'rpc'|'pillar'|'pillar2'|'pillar3'|'observer';
  readProfile: () => Promise<string>; readLogs: () => Promise<Record<string, unknown>>;
}): Promise<Record<string, any>>
