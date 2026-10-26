import type { OrchestrationSummary, SessionSummary, UsageEstimate, UsageSample, UsageScope } from '../../shared/contract'

export interface UsageScopeCtx {
  sessions: Record<string, SessionSummary>
  orchestration: OrchestrationSummary | null
}

type Ref = Pick<UsageSample, 'sessionId' | 'rootId'> | Pick<UsageEstimate, 'sessionId' | 'rootId'>

/** Does a call (or an in-flight estimate) of `ref` belong to `scope`? Pure; shared by samples and estimates. */
export function refInScope(ref: Ref, scope: UsageScope, ctx: UsageScopeCtx): boolean {
  switch (scope.kind) {
    case 'fleet':
      return true
    case 'session':
      return ref.sessionId === scope.id
    case 'workflow':
      return (ref.rootId ?? ctx.sessions[ref.sessionId]?.rootId ?? null) === scope.id
    case 'run': {
      const s = ctx.sessions[ref.sessionId]
      const rootId = ref.rootId ?? s?.rootId ?? null
      const root = rootId ? ctx.sessions[rootId] : undefined
      if (s?.orca?.runId === scope.id || root?.orca?.runId === scope.id) return true
      const run = ctx.orchestration?.runs.find((r) => r.id === scope.id)
      const coord = run?.coordinatorSessionId
      return !!coord && (coord === ref.sessionId || coord === rootId)
    }
  }
}

export const sampleInScope = (s: UsageSample, scope: UsageScope, ctx: UsageScopeCtx): boolean => refInScope(s, scope, ctx)
export const estimateInScope = (e: UsageEstimate, scope: UsageScope, ctx: UsageScopeCtx): boolean => refInScope(e, scope, ctx)
