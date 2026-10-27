export function agreesAtHeight(samples: unknown[], height: number): boolean
export function readyAtFrontier(anchor: unknown, nodes: unknown[]): boolean
export function readinessFailureDiagnostics(read: (port: number, method: string, params: unknown[]) => Promise<unknown>, comparisonHeight?: number): Promise<{
  schema: number
  scope: string
  status: string
  earlyHeight: number
  earlyHashesAgree: boolean | null
  comparisonHeight: number
  commonHashesAgree: boolean | null
  nodes: Array<{ port: number; peerCount: number | null; sync: { state: number; currentHeight: number; targetHeight: number } | null; earlyMomentum: { height: number; chainIdentifier: number; hash: string } | null; commonMomentum: { height: number; chainIdentifier: number; hash: string } | null; unavailable: string[] }>
}>
