/** Desktop tool dispatch requires the bundled preservation policy for the entire host lifetime. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Published only after the bundled policy has installed its guards. */
    autoModeProtection: { readonly policy: 'preservation-v1'; readonly enforceAllSessions: boolean; readonly modelReview: boolean; readonly epoch: string; readonly signal: AbortSignal }
  }
}

/** Return a blocking diagnostic while the required protection is unavailable. */
export function protectionFailure(ctx: Context): string | undefined {
  const policy = ctx.get('autoModeProtection')
  return policy?.policy === 'preservation-v1' && policy.enforceAllSessions && policy.modelReview && !policy.signal.aborted
    ? undefined : 'Desktop safety policy is unavailable. Restart or reinstall this release; tools are blocked.'
}

/** Install a host-owned guard that remains effective when the policy plugin stops. */
export function installProtectionGate(ctx: Context): void {
  const prepared = new Map<symbol, Context['autoModeProtection']>()
  const requirePolicy = (token: symbol): Context['autoModeProtection'] => {
    const failure = protectionFailure(ctx)
    const policy = ctx.get('autoModeProtection')
    if (failure !== undefined || policy === undefined) throw new Error(failure ?? 'Desktop safety policy is unavailable.')
    if (prepared.get(token)?.epoch !== policy.epoch) throw new Error('Desktop safety policy changed after preparation; retry the operation.')
    policy.signal.throwIfAborted()
    return policy
  }
  const requireActor = (actor: object | undefined): void => {
    const token: unknown = actor === undefined ? undefined : Reflect.get(actor, 'token')
    if (typeof token !== 'symbol') throw new Error('Desktop file changes require a reviewed tool call.')
    requirePolicy(token)
  }
  ctx.inject(['tools'], (scope) => {
    scope.tools.guard((exec) => {
      const failure = protectionFailure(ctx)
      if (failure !== undefined) return failure
      const policy = ctx.get('autoModeProtection')
      if (policy === undefined) return 'Desktop safety policy is unavailable.'
      prepared.set(exec.token, policy)
      return undefined
    })
    scope.tools.guard((exec) => {
      requirePolicy(exec.token)
      return undefined
    }, 'dispatch')
  })
  ctx.on('tools/execute', async (exec, next) => {
    const policy = requirePolicy(exec.token)
    const previous = exec.signal
    exec.signal = AbortSignal.any([previous, policy.signal])
    try { return await next() }
    finally { exec.signal = previous }
  }, { prepend: true })
  // These listeners outlive plugin unload, including an already-started file tool.
  ctx.on('fs/write-intent', async (_target, actor, next) => {
    const intent = await next()
    requireActor(actor)
    if (intent === undefined) throw new Error('Desktop file write lacks an exact conditional approval.')
    return intent
  }, { prepend: true })
  ctx.on('fs/edit-intent', async (_target, actor, next) => {
    const intent = await next()
    requireActor(actor)
    if (intent === undefined) throw new Error('Desktop file edit lacks an exact conditional approval.')
    return intent
  }, { prepend: true })
  ctx.on('tools/result', (exec) => { prepared.delete(exec.token) })
  ctx.effect(() => () => { prepared.clear() }, 'desktop protection prepared calls')
}
