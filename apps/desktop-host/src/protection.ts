/** Host-owned revocation for calls prepared in Auto; native modes retain their own policy. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Published only after the bundled policy has installed its guards. */
    autoModeProtection: { readonly policy: 'preservation-v1'; readonly enforceAllSessions: boolean; readonly modelReview: boolean; readonly epoch: string; readonly signal: AbortSignal }
  }
}

/** Return the Auto-specific failure; native modes do not require this plugin. */
export function protectionFailure(ctx: Context): string | undefined {
  const policy = ctx.get('autoModeProtection')
  return policy?.policy === 'preservation-v1' && policy.modelReview && !policy.signal.aborted
    ? undefined : 'Auto review is unavailable. Restart the plugin or choose a native permission mode.'
}

/** Permission history identifies a switch away and back as a change too. */
function permissionStamp(session: Session): string {
  const entries = []
  for (let i = session.seq - 1; i >= 0; i--) {
    // oxlint-disable-next-line typescript/no-deprecated -- Capture switch-away-and-back as well as the current value.
    const event = session.eventAt(SessionSeq(i))
    if (event?.type === 'permission/preset' || event?.type === 'sandbox/mode' || event?.type === 'approval/policy') entries.push(event)
  }
  return JSON.stringify(entries)
}

/** Install lifetime checks outside the unloadable Auto plugin. */
export function installProtectionGate(ctx: Context): void {
  interface Prepared {
    auto: boolean
    policy: Context['autoModeProtection'] | undefined
    sessions: Array<{ session: Session; stamp: string }>
  }
  const prepared = new Map<symbol, Prepared>()
  const capture = (exec: Readonly<ToolExecution>): Prepared => {
    const sessions: Prepared['sessions'] = []
    const seen = new Set<Session>()
    let agent = exec.agent
    let auto = false
    while (agent !== undefined && !seen.has(agent.session)) {
      const session = agent.session
      seen.add(session)
      const mode = ctx.permissionPresets.current(session)
      if (mode === 'custom') throw Error('Saved permissions are inconsistent. Select Read only, Workspace write, Full access, or Auto before continuing.')
      auto ||= mode === 'preservation'
      sessions.push({ session, stamp: permissionStamp(session) })
      agent = session.header.origin === 'subagent' && session.header.parentSession !== undefined
        ? ctx.get('agents')?.get(session.header.parentSession) : undefined
    }
    return { auto, policy: auto ? ctx.get('autoModeProtection') : undefined, sessions }
  }
  const validate = (exec: Readonly<ToolExecution>): Prepared | undefined => {
    const initial = prepared.get(exec.token)
    const current = capture(exec)
    if (!initial?.auto && !current.auto) return undefined
    if (!initial || initial.auto !== current.auto || initial.sessions.some(({ session, stamp }) => stamp !== permissionStamp(session))) {
      throw Error('Auto permission mode changed after preparation; this call was cancelled. Submit a new call.')
    }
    const failure = protectionFailure(ctx)
    if (failure !== undefined) throw Error(failure)
    if (initial.policy?.epoch !== ctx.get('autoModeProtection')?.epoch || initial.policy?.signal.aborted) throw Error('Auto plugin was replaced after preparation; this call was cancelled.')
    return initial
  }
  ctx.on('tools/pre-execute', async (exec, next) => {
    const initial = capture(exec)
    prepared.set(exec.token, initial)
    if (initial.auto) {
      const failure = protectionFailure(ctx)
      if (failure !== undefined) return { kind: 'deny', reason: failure }
    }
    return next()
  }, { prepend: true })
  ctx.inject(['tools'], (scope) => {
    const guard = (exec: Readonly<ToolExecution>): string | undefined => {
      try { validate(exec); return undefined }
      catch (error) { return error instanceof Error ? error.message : 'Auto preparation is no longer valid.' }
    }
    scope.tools.guard(guard)
    scope.tools.guard(guard, 'dispatch')
  })
  ctx.on('tools/execute', async (exec, next) => {
    const initial = validate(exec)
    if (initial?.policy === undefined) return next()
    const previous = exec.signal
    exec.signal = AbortSignal.any([previous, initial.policy.signal])
    try { return await next() }
    finally { exec.signal = previous }
  }, { prepend: true })
  const checkCommit = (actor: object | undefined, intent: unknown): void => {
    if (actor === undefined || !('token' in actor)) return
    const exec = actor as ToolExecution
    if (validate(exec) !== undefined && intent === undefined) throw Error('Auto file change lacks its conditional approval.')
  }
  ctx.on('fs/write-intent', async (_target, actor, next) => {
    const intent = await next()
    checkCommit(actor, intent)
    return intent
  }, { prepend: true })
  ctx.on('fs/edit-intent', async (_target, actor, next) => {
    const intent = await next()
    checkCommit(actor, intent)
    return intent
  }, { prepend: true })
  ctx.on('tools/result', (exec) => { prepared.delete(exec.token) })
  ctx.effect(() => () => { prepared.clear() }, 'desktop prepared Auto calls')
}
