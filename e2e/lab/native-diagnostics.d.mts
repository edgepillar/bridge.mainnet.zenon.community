export function summarizeSyncLog(text: string): Record<string, any>
export function summarizeGoroutines(text: string): Record<string, any>
export function collectNativeFailureFacts(input: {
  runtime: unknown; build: unknown; head: string; tree: string;
  readProfile: () => Promise<string>; readLogs: () => Promise<Record<string, unknown>>;
}): Promise<Record<string, any>>
