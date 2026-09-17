import { createHash, randomUUID } from 'node:crypto'
import { symbols, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: declares the Alpha.2 permissionPresets service on Cordis Context.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import { sanitizeClassifierText } from './classifier.js'
import { AutoReviewFailure, classifyRisk, snapshotAutoReview, hasExplanation, type AutoReviewDecision, type ReviewExplanation } from './upstream-review/index.js'
import { assertHarnessCompatibility, sessionEventsNewestFirst } from './harness-compat.js'
import { normalizePath, resolveRoots, type RootOptions } from './paths.js'
import { inspectStructuredPath, readVerifiedFile, sameFileAncestors } from './file-boundary.js'
import { registerManagedFile } from './managed-file.js'
import { beginReviewAudit } from './review-audit.js'
import { recordFileCommit } from './records.js'
import { FileRecordRegistry } from './probe-registry.js'
import { prepareNativeExecution, original, type NativeExecution } from './native-execution.js'
import { installSearchPolicy } from './search.js'
import { inspectDirectory, registerManagedList } from './managed-list.js'
import { assessTool, fileApprovalIdentity, hardDenyReason, sandboxRequestState, structuredFilePath, supportsAutoTool } from './policy.js'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

export { ArtifactRegistry } from './artifacts.js'
/** @deprecated Standalone legacy utility; never an authorization source for Auto. */
export { createHttpClassifier, sanitizeClassifierArguments, type HttpClassifierConfig } from './classifier.js'
/** @deprecated Standalone legacy utility; never an authorization source for Auto. */
export { createDshClassifier, type DshClassifierConfig } from './dsh-classifier.js'
export { AutoApprovalGrants } from './escalation.js'
export * from './paths.js'
export * from './policy.js'
export * from './shell.js'
export type * from './types.js'

export const name = 'auto-permission-mode'
export const inject = ['tools', 'permissionPresets']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Live policy identity used by desktop startup and tool dispatch checks. */
    autoModeProtection: { readonly policy: 'preservation-v1'; readonly enforceAllSessions: boolean; readonly modelReview: boolean; readonly epoch: string; readonly signal: AbortSignal }
  }
}
/** Official permission preset key that activates this policy. */
export const AUTO_PERMISSION_PRESET = 'preservation'

export const AUTO_MODE_REDUNDANT_SANDBOX_MARKER = '[auto-mode redundant sandbox request]'
export const AUTO_MODE_REDUNDANT_SANDBOX_REASON = `${AUTO_MODE_REDUNDANT_SANDBOX_MARKER} Auto already runs in workspace-write. Retry the same tool call after completely removing sandbox_permissions and justification; this call did not execute.`
export const AUTO_MODE_REDUNDANT_SANDBOX_RETRY_CONTEXT = [
  'AUTO MODE RECOVERY NOTICE: The immediately preceding tool call did not execute.',
  `It was blocked by ${AUTO_MODE_REDUNDANT_SANDBOX_MARKER}; this is not an escalation request.`,
  'Your next tool call must retry the same ordinary workspace operation with both object properties completely absent: sandbox_permissions and justification.',
  'Do not send either property as null, an empty string, whitespace, or workspace-write. Do not change the target, add unrelated work, or switch to danger-full-access.',
  'After the field-less retry succeeds, continue with normal result verification.',
].join('\n')

/** Dynamic Agent guidance shown only while Auto (or inherited Auto) is active. */
export const AUTO_MODE_AGENT_GUIDANCE = [
  '<auto_mode_policy>',
  'Auto reviews each call against the human task, complete arguments and inspected file/execution facts. Reasonable filenames, implementation and verification steps may be delegated by the user.',
  'Use the installed native file, search, shell and background job tools. Commands, dependency installation, builds and tests run through the native workspace-write sandbox. It has partial protection on Windows: it does not isolate all reads, networking or external writes. Model review is not OS isolation.',
  'If the native sandbox denies a necessary command, request sandbox_permissions:danger-full-access with a concrete justification for the exact retry. Auto first reviews it; a suggested execution asks the user once. Approval applies to that call only and never grants administrator rights. Do not work around a rejection through another interpreter or subprocess.',
  'For a user-requested external write/delete test, choose a new independent file at a reasonable ordinary location and use managed_file write with create_only:true. Read or stat it, reversibly trash it and verify_recovery using its original path. The user may delegate location and name; no special filename prefix is required.',
  'Use managed_file for recoverable single-file removal and exact external mutations. Existing files still need actual task authorization; a test label or a prior creation is not permission. Do not delete directories, roots, credentials or recovery data. Ordinary writes do not automatically create backups. Arbitrary script changes do not use managed_file recovery.',
  'glob, grep and managed_list provide bounded searches with protected paths and links excluded. Read specific results for verification. Unavailable providers report their actual limitation; do not treat missing execution capability as missing human authorization.',
  'A model denial stops the call without a human prompt. A suggested action that needs missing authorization or wider permissions displays its purpose, authority, scope and possible consequences. Changed arguments, files, provider, mode or cancellation invalidate the approval.',
  '</auto_mode_policy>',
].join('\n')

/** Host policy configuration. Legacy classifier routing fields are ignored; reviews use the active agent model. */
export interface Config {
  /** Review every structurally admissible call using the current agent's model. */
  readonly modelReview?: boolean
  /** Model review deadline; expiry never allows execution. */
  readonly reviewTimeoutMs?: number
  /** Legacy configuration accepted but ignored; Auto never overrides native permission modes. */
  readonly enforceAllSessions?: boolean
  readonly presetName?: string
  readonly workspaceRoot?: string
  readonly dshHome?: string
  readonly tempRoots?: string[]
  readonly classifierEndpoint?: string
  readonly classifierProvider?: string
  readonly classifierModel?: string
  readonly classifierApiKeyEnv?: string
  readonly classifierTimeoutMs?: number
  readonly classifierMaxOutputTokens?: number
}

export const Config: z<Config> = z.object({
  modelReview: z.boolean().default(true),
  reviewTimeoutMs: z.number().min(100).max(120_000).default(30_000),
  enforceAllSessions: z.boolean().default(false),
  presetName: z.string().default(AUTO_PERMISSION_PRESET),
  workspaceRoot: z.string(),
  dshHome: z.string(),
  tempRoots: z.array(z.string()),
  classifierEndpoint: z.string(),
  classifierProvider: z.string(),
  classifierModel: z.string(),
  classifierApiKeyEnv: z.string().default('DEEPSEEK_API_KEY'),
  classifierTimeoutMs: z.number().default(30_000),
  classifierMaxOutputTokens: z.number().default(1_024),
})

type AgentSession = NonNullable<ToolExecution['agent']>['session']

/** Current preset resolver supplied by the Alpha.2 permission projection service. */
export interface CurrentPermissionPreset {
  (session: AgentSession): string
}

/** Whether the pending tool call belongs to a session currently using the Auto permission preset. */
export function isAutoPermissionExecution(
  exec: Readonly<ToolExecution>,
  currentPreset: CurrentPermissionPreset,
  presetName = AUTO_PERMISSION_PRESET,
): boolean {
  return exec.agent !== undefined && currentPreset(exec.agent.session) === presetName
}

type ParentSessionId = NonNullable<NonNullable<ToolExecution['agent']>['session']['header']['parentSession']>

interface ParentAgentLookup {
  (sessionId: ParentSessionId): ToolExecution['agent'] | undefined
}

/**
 * Auto is a session capability, so official in-process subagents inherit it
 * through their durable parentSession lineage. DSH already inherits the
 * parent's tool composition/sandbox but deliberately pins child approval to
 * `never`; applying Auto to every child tool call keeps routine work moving
 * while ambiguous calls fail closed instead of bypassing this policy.
 */
export function isAutoOrDelegatedPermissionExecution(
  exec: Readonly<ToolExecution>,
  parentAgent: ParentAgentLookup,
  currentPreset: CurrentPermissionPreset,
  presetName = AUTO_PERMISSION_PRESET,
): boolean {
  return autoPermissionAuthority(exec, parentAgent, currentPreset, presetName) !== undefined
}

/** Resolve the Auto session imposing policy on this execution. Chat text never authorizes it. */
export function autoPermissionAuthority(
  exec: Readonly<ToolExecution>,
  parentAgent: ParentAgentLookup,
  currentPreset: CurrentPermissionPreset,
  presetName = AUTO_PERMISSION_PRESET,
): ToolExecution['agent'] | undefined {
  if (isAutoPermissionExecution(exec, currentPreset, presetName)) return exec.agent
  let session = exec.agent?.session
  const visited = new Set<string>()
  while (session?.header?.origin === 'subagent' && session.header.parentSession !== undefined) {
    const parentSessionId = session.header.parentSession
    const parentKey = String(parentSessionId)
    if (visited.has(parentKey)) return undefined
    visited.add(parentKey)
    const parent = parentAgent(parentSessionId)
    if (parent === undefined) return undefined
    const parentExec = { ...exec, agent: parent }
    if (isAutoPermissionExecution(parentExec, currentPreset, presetName)) return parent
    session = parent.session
  }
  return undefined
}

export function trustedUserMessages(authority: ToolExecution['agent']): string[] {
  if (authority === undefined) return []
  const messages: string[] = []
  let remaining = 4_000
  for (const event of sessionEventsNewestFirst(authority.session)) {
    if (messages.length >= 4 || remaining <= 0) break
    if (event?.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const text = event.data.content
      .filter((block): block is Extract<(typeof event.data.content)[number], { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text === '') continue
    const sanitized = sanitizeClassifierText(text).slice(0, remaining)
    messages.push(sanitized)
    remaining -= sanitized.length
  }
  return messages.reverse()
}

function isRedundantSandboxResult(result: Readonly<ToolExecutionResult>): boolean {
  return result.isError && result.error.message === AUTO_MODE_REDUNDANT_SANDBOX_REASON
}

function redundantSandboxRetryContext() {
  return createUserMessage({
    content: [{ type: 'text', text: AUTO_MODE_REDUNDANT_SANDBOX_RETRY_CONTEXT }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: 'Auto Mode requires a field-less retry.',
    },
  })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Bind model-approved or manually confirmed operations to deterministic checks and single-use execution. */
export function apply(ctx: Context, config: Config = {}): void {
  assertHarnessCompatibility()
  const modelReview = config.modelReview !== false
  const presetName = config.presetName ?? AUTO_PERMISSION_PRESET
  const rootOptions: RootOptions = {
    ...(config.workspaceRoot === undefined ? {} : { workspaceRoot: config.workspaceRoot }),
    ...(config.dshHome === undefined ? {} : { dshHome: config.dshHome }),
    ...(config.tempRoots === undefined ? {} : { tempRoots: config.tempRoots }),
  }
  const rootsFor = (exec: Readonly<ToolExecution>) => resolveRoots(exec.agent?.session.header.cwd, rootOptions)
  const files = new FileRecordRegistry()
  const nativeCalls = new Map<symbol, NativeExecution>()
  const preparedCalls = new Map<symbol, ToolExecution>()
  const humanInstructionsFor = (exec: ToolExecution) => exec.agent === undefined || !modelReview ? [] : snapshotAutoReview(exec.agent, exec).history
    .flatMap(entry => entry.kind === 'user-message' && entry.role === 'human-instruction'
      ? entry.content.flatMap(block => block.type === 'text' && block.text.trim() ? [block.text] : []) : [])
  const executionFacts = (exec: ToolExecution) => {
    const roots = rootsFor(exec)
    const args = record(exec.arguments)
    const fileTool = ['managed_file', 'read', 'read_image', 'write', 'edit', 'str_replace_editor'].includes(exec.name)
    const path = fileTool ? structuredFilePath(exec, roots) : undefined
    const file = path === undefined ? undefined : inspectStructuredPath(path, roots, true, true, true)
    return { ...(path === undefined || file === undefined ? {} : { file: { path, exists: !file.identity.includes('"absent"'),
      withinWorkspace: file.withinWorkspace, recordedVersion: files.matches(exec, path, roots), createdBySession: files.created(exec, path, roots) } }),
      ...(nativeCalls.get(exec.token)?.facts === undefined ? {} : { execution: nativeCalls.get(exec.token)!.facts! }) }
  }
  const parentAgent: ParentAgentLookup = sessionId => ctx.get('agents')?.get(sessionId)
  const authorityFor = (exec: Readonly<ToolExecution>) => autoPermissionAuthority(exec, parentAgent, session => ctx.permissionPresets.current(session), presetName)
  interface Ticket {
    agent: ToolExecution['agent']
    authority: ToolExecution['agent']
    fingerprint: string
    approved: boolean
    approvedBy: 'model' | 'human'
    managedConsumed?: boolean
    sandboxConsumed?: boolean
    shellAuthorized?: boolean
    shellConsumed?: boolean
    committedVersion?: FsVersion
    guarded?: boolean
    file?: { fs: Context['fs']; target: FsTarget; version: FsVersion | undefined; consumed: boolean; initialIdentity: string }
  }
  const tickets = new Map<symbol, Ticket>()
  const observed = new Map<symbol, { agent: ToolExecution['agent']; authority: ToolExecution['agent']; presetHistory: string; revoke: AbortController }>()
  const dispatched = new Set<symbol>()
  const reviews = new Map<symbol, { fingerprint: string; expires: number; decision: 'allow' | 'ask'; risk: 'low' | 'medium'; provider: string; model: string; reasoningEffort?: string; reason?: string; explanation?: ReviewExplanation }>()
  const presetHistory = (agent: ToolExecution['agent']): string => JSON.stringify(agent === undefined ? [] :
    Array.from(sessionEventsNewestFirst(agent.session)).filter(event => event.type === 'permission/preset' || String(event.type) === 'sandbox/mode' || event.type === 'approval/policy'))
  let active = true
  const disposal = new AbortController()
  ctx.effect(() => () => { active = false; disposal.abort(); tickets.clear(); observed.clear(); reviews.clear(); nativeCalls.clear(); preparedCalls.clear() }, 'auto-mode: pending approvals')
  const fingerprint = (exec: Readonly<ToolExecution>): string => {
    nativeCalls.get(exec.token)?.validate()
    const value = JSON.stringify({ name: exec.name, arguments: exec.arguments, callId: exec.callId, roots: rootsFor(exec), fileIdentity: fileApprovalIdentity(exec, rootsFor(exec)), execution: nativeCalls.get(exec.token)?.facts })
    if (value.length > 1_000_000) throw new Error('approval payload exceeds the complete-call limit; split the operation')
    return createHash('sha256').update(value).digest('hex')
  }
  const evaluate = (exec: Readonly<ToolExecution>) => {
    const roots = rootsFor(exec)
    const assessment = assessTool(exec, roots)
    if (assessment.decision === 'deny' || !['read', 'read_image', 'write', 'edit', 'str_replace_editor', 'managed_file', 'managed_list'].includes(exec.name)) return assessment
    try {
      const path = exec.name === 'managed_list' ? inspectDirectory(String(record(exec.arguments)?.directory), roots).path : structuredFilePath(exec, roots)
      const mapped = ctx.get('fs')?.processPathFromHostPath(path)
      // A remote provider can expose an identical path spelling in a different world.
      if (mapped === undefined || normalizePath(mapped, roots.workspace) !== normalizePath(path, roots.workspace)) throw Error('not a verified host file mapping')
      return assessment
    } catch {
      return { decision: 'deny' as const, reason: 'Auto cannot verify that this filesystem accesses the inspected host file', classifierEligible: false }
    }
  }
  const reviewFingerprint = (exec: ToolExecution): string => {
    if (exec.agent === undefined) throw Error('model review requires an agent')
    // Tool/job facts cannot add or revoke human authorization. Pending human inputs
    // revoke through their inbox event before they reach the model transcript.
    const snapshot = JSON.stringify(snapshotAutoReview(exec.agent, exec, executionFacts(exec)).history.filter(entry => entry.kind === 'user-message' && entry.role === 'human-instruction'))
    if (Buffer.byteLength(snapshot) > 1_000_000) throw Error('review input exceeds the complete-call limit')
    return createHash('sha256').update(snapshot).update(fingerprint(exec)).update(presetHistory(authorityFor(exec))).digest('hex')
  }
  const reviewMatches = (exec: ToolExecution): boolean => {
    if (!modelReview) return true
    try {
      const review = reviews.get(exec.token)
      return review !== undefined && Date.now() < review.expires && review.fingerprint === reviewFingerprint(exec)
    }
    catch { return false }
  }
  const hard = (exec: Readonly<ToolExecution>): string | undefined => {
    const mutation = ['write', 'edit'].includes(exec.name)
      || (exec.name === 'str_replace_editor' && record(exec.arguments)?.command !== 'view')
      || (exec.name === 'managed_file' && ['write', 'edit', 'trash'].includes(String(record(exec.arguments)?.operation)))
    if (mutation) {
      const policy = ctx.get('sandboxPolicy')?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
      if ((policy?.mode ?? ctx.get('fs')?.sandboxMode) === 'read-only'
        || (exec.agent !== undefined && ctx.permissionPresets.current(exec.agent.session) === 'read-only')) return 'Read-only mode forbids file changes, including reversible trash'
    }
    const reason = hardDenyReason(exec, rootsFor(exec))
    if (reason !== undefined) return reason
    const sandbox = sandboxRequestState(exec.arguments)
    if (sandbox.kind === 'redundant-standing') return AUTO_MODE_REDUNDANT_SANDBOX_REASON
    if (sandbox.kind === 'invalid') return 'Auto received invalid sandbox permission arguments'
    if (sandbox.kind === 'widening' && !sandbox.request.justification.trim()) return 'Sandbox widening requires a concrete justification'
    return undefined
  }
  ctx.on('session/event', (session, event) => {
    if (!['permission/preset', 'sandbox/mode', 'approval/policy', 'user/message', 'agent/inbox/spliced'].includes(event.type)) return
    const changesInstructions = (source: import('@deepseek-ai/dsh-llm').UserMessage['source']) => source.kind === 'user'
      || (source.kind === 'agent-message' && source.senderSessionId === session.header.parentSession)
    if (event.type === 'user/message' && !changesInstructions(event.data.source)) return
    if (event.type === 'agent/inbox/spliced' && !event.data.inserted.some(message => changesInstructions(message.source))) return
    for (const initial of observed.values()) {
      if (session === initial.agent?.session || session === initial.authority?.session) initial.revoke.abort()
    }
  })
  ctx.on('session/disposed', session => {
    for (const initial of observed.values()) if (session === initial.agent?.session || session === initial.authority?.session) initial.revoke.abort()
  })
  ctx.on('approval/consume-execution', async (request, next) => {
    const token = request.execution.token
    const ticket = tickets.get(token)
    const initial = observed.get(token)
    if (initial === undefined && authorityFor({ agent: request.agent } as ToolExecution) === undefined) return next()
    if (initial === undefined || !active || !ticket?.guarded || ticket.sandboxConsumed || ticket.approvedBy !== 'human' || initial?.revoke.signal.aborted) return 'rejected'
    const call = preparedCalls.get(token)
    const native = nativeCalls.get(token)
    if (call === undefined || native === undefined || request.agent !== call.agent || request.callId !== call.callId || request.toolName !== call.name
      || JSON.stringify(request.execution.parameters) !== JSON.stringify(call.arguments) || request.execution.requestedMode !== native.mode
      || native.mode !== 'danger-full-access' || original(request.execution.provider) !== original(native.provider)
      || normalizePath(request.execution.workdir, rootsFor(call).workspace) !== normalizePath(native.workdir, rootsFor(call).workspace)
      || ticket.fingerprint !== fingerprint(call) || !reviewMatches(call) || authorityFor(call) !== ticket.authority
      || initial.presetHistory !== presetHistory(ticket.authority)) return 'rejected'
    native.validate()
    ticket.sandboxConsumed = true
    return 'allowed-once'
  }, { prepend: true })
  ctx.on('shell/authorize', async (actor, provider, spec, next) => {
    const exec = actor as ToolExecution
    if (!observed.has(exec.token) && authorityFor(exec) === undefined) return next()
    const ticket = tickets.get(exec.token)
    const native = nativeCalls.get(exec.token)
    const validate = () => {
      if (!active || !ticket?.guarded || native?.validateSpec === undefined || !reviewMatches(exec)
        || ticket.fingerprint !== fingerprint(exec) || ticket.authority !== authorityFor(exec)
        || observed.get(exec.token)?.presetHistory !== presetHistory(ticket.authority)) throw Error('Auto native launch authorization changed')
      native.validateSpec(spec, provider)
      if (native.mode === 'danger-full-access' && !ticket.sandboxConsumed) throw Error('Auto native widening lacks its one-shot human approval')
    }
    validate()
    if (ticket!.shellAuthorized) throw Error('Auto command authorization was replayed')
    ticket!.shellAuthorized = true
    const prior = await next()
    const approved = { ...prior, signal: AbortSignal.any([prior.signal ?? exec.signal, native!.signal]),
      beforeSpawn: (actual: typeof spec, actualProvider: object) => {
        ;(prior as typeof prior & { beforeSpawn?: (spec: typeof prior, provider: object) => void }).beforeSpawn?.(actual, actualProvider)
        validate()
        native!.validateSpec!(actual, actualProvider)
        if (ticket!.shellConsumed) throw Error('Auto native launch authorization was already consumed')
        // An inner tool wrapper cannot reuse this grant for a second process.
        ticket!.shellConsumed = true
      } }
    return approved
  }, { prepend: true })
  ctx.inject(['systemPrompt'], scope => {
    scope.systemPrompt.context({
      name: 'auto-mode:policy', order: 111,
      text: ({ agent }) => agent !== undefined && authorityFor({ agent } as Readonly<ToolExecution>) !== undefined
        ? AUTO_MODE_AGENT_GUIDANCE : '',
    })
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const resolved = await next()
    if (context.agent === undefined || authorityFor({ agent: context.agent } as ToolExecution) === undefined) {
      return { ...resolved, tools: resolved.tools.filter(tool => tool.name !== 'managed_file' && tool.name !== 'managed_list') }
    }
    return resolved
  }, { prepend: true })

  // This guard also runs when a different pre-execute listener short-circuits our listener.
  ctx.tools.guard(exec => {
    const ticket = tickets.get(exec.token)
    const initial = observed.get(exec.token)
    const authority = authorityFor(exec)
    if (authority === undefined && ticket === undefined && initial === undefined) return undefined
    if (!active || exec.signal.aborted) return 'Auto approval was cancelled or disposed'
    if (initial !== undefined && (initial.authority !== authority || initial.agent !== exec.agent || initial.presetHistory !== presetHistory(authority))) {
      return 'Auto permission state changed during this tool execution'
    }
    if (ticket !== undefined && (ticket.authority !== authority || ticket.agent !== exec.agent)) {
      return 'Auto authority changed while approval was pending'
    }
    const reason = hard(exec)
    if (reason !== undefined) return reason
    const assessment = evaluate(exec)
    if (assessment.decision === 'deny') return assessment.reason
    if (!reviewMatches(exec)) return 'Auto requires a fresh model review bound to the exact call and current authorization'
    try {
      if (ticket?.approved && ticket.fingerprint === fingerprint(exec)) {
        ticket.approved = false // One execution, never a standing or reusable grant.
        ticket.guarded = true
        return undefined
      }
    } catch { return 'Auto could not bind approval to the complete tool call' }
    return 'Auto requires fresh exact authorization; another listener cannot bypass this guard'
  })
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const authority = authorityFor(exec)
    if (authority === undefined) return next()
    preparedCalls.set(exec.token, exec)
    observed.set(exec.token, { agent: exec.agent, authority, presetHistory: presetHistory(authority), revoke: new AbortController() })
    const reason = hard(exec)
    if (reason !== undefined) {
      return { kind: 'deny', reason }
    }
    const assessment = evaluate(exec)
    if (assessment.decision === 'deny') return { kind: 'deny', reason: `[auto-mode blocked] ${assessment.reason}` }
    const callSignal = AbortSignal.any([exec.signal, disposal.signal, observed.get(exec.token)!.revoke.signal])
    try { nativeCalls.set(exec.token, await prepareNativeExecution(ctx, exec, rootsFor(exec), callSignal)) }
    catch (error) { return { kind: 'deny', reason: `[auto-mode execution unavailable: ${error instanceof Error ? error.message : 'provider-preparation-failed'}] operation did not execute` } }

    if (modelReview) {
      exec.agent?.session.append('approval/review-input', { callId: exec.callId, facts: executionFacts(exec) })
      if (exec.agent === undefined || ctx.get('llm') === undefined) return { kind: 'deny', reason: '[auto-mode review unavailable] operation did not execute' }
      const signal = AbortSignal.any([callSignal, AbortSignal.timeout(config.reviewTimeoutMs ?? 30_000)])
      let cancel: (() => void) | undefined
      try {
        signal.throwIfAborted()
        const expected = reviewFingerprint(exec)
        const cancelled = new Promise<never>((_resolve, reject) => {
          cancel = () => { reject(new Error('model review cancelled or timed out')) }
          signal.addEventListener('abort', cancel, { once: true })
        })
        let decision = await Promise.race([classifyRisk(ctx, exec.agent, exec, signal, executionFacts(exec)), cancelled])
        signal.throwIfAborted()
        if (decision.decision === 'deny') return { kind: 'deny', reason: `[auto-mode model recommendation: deny] ${sanitizeClassifierText(decision.reason ?? 'The requested effects are not authorized.')}` }
        if (!active || expected !== reviewFingerprint(exec)) {
          return { kind: 'deny', reason: '[auto-mode model review rejected or authorization changed] operation did not execute' }
        }
        const needsHuman = decision.decision === 'ask' || sandboxRequestState(exec.arguments).kind === 'widening'
        const requiresRemovalExplanation = exec.name === 'managed_file' && record(exec.arguments)?.operation === 'trash' && executionFacts(exec).file?.createdBySession !== true
        if ((needsHuman || requiresRemovalExplanation) && !hasExplanation(decision)) {
          const initialDecision = decision.decision
          decision = await Promise.race([classifyRisk(ctx, exec.agent, exec, signal, executionFacts(exec), true), cancelled])
          signal.throwIfAborted()
          if (decision.decision === 'deny' || !hasExplanation(decision) || expected !== reviewFingerprint(exec)) {
            return { kind: 'deny', reason: '[auto-mode explanation unavailable or recommendation denied] operation did not execute' }
          }
          if (initialDecision === 'ask') decision = { ...decision, decision: 'ask' }
        }
        const snapshot = snapshotAutoReview(exec.agent, exec)
        reviews.set(exec.token, { fingerprint: expected, expires: Date.now() + 120_000, decision: decision.decision, risk: decision.risk,
          provider: snapshot.provider, model: snapshot.model,
          ...(decision.reasoningEffort === undefined ? {} : { reasoningEffort: decision.reasoningEffort }),
          ...(decision.reason !== undefined ? { reason: sanitizeClassifierText(decision.reason) } : {}),
          ...(hasExplanation(decision) ? { explanation: { purpose: sanitizeClassifierText(decision.purpose), authorization: sanitizeClassifierText(decision.authorization), scope: sanitizeClassifierText(decision.scope), consequences: sanitizeClassifierText(decision.consequences) } } : {}) })
      } catch (error) {
        const code = exec.signal.aborted || disposal.signal.aborted ? 'cancelled'
          : signal.aborted ? 'timeout' : error instanceof AutoReviewFailure ? error.code : 'context-invalid'
        return { kind: 'deny', reason: `[auto-mode model review failed: ${code}] operation did not execute` }
      } finally {
        if (cancel !== undefined) signal.removeEventListener('abort', cancel)
      }
    }
    const review = reviews.get(exec.token)
    const humanInstructions = humanInstructionsFor(exec)
    const managed = exec.name === 'managed_file'
    const automatic = modelReview ? review?.decision === 'allow' && humanInstructions.length > 0
      && sandboxRequestState(exec.arguments).kind !== 'widening' : assessment.decision === 'allow'
    const approval = ctx.get('approval')
    if ((!automatic && approval === undefined) || exec.agent === undefined || exec.callId === undefined) {
      return { kind: 'deny', reason: '[auto-mode exact authorization unavailable] this operation did not execute' }
    }
    if (!automatic && (authority !== exec.agent || exec.agent.session.header.origin === 'subagent')) return { kind: 'deny', reason: '[auto-mode delegated approval denied] report the blocked operation to the parent' }
    try {
      const ticket: Ticket = { agent: exec.agent, authority, fingerprint: fingerprint(exec), approved: false, approvedBy: automatic ? 'model' : 'human' }
      if (assessment.filesystemEffects !== undefined || managed) {
        const fs = ctx.get('fs')
        if (fs === undefined) throw Error('verified filesystem service unavailable')
        const path = structuredFilePath(exec, rootsFor(exec))
        const target = await fs.resolve(path, { signal: exec.signal })
        if (normalizePath(fs.processPath(target), rootsFor(exec).workspace) !== normalizePath(path, rootsFor(exec).workspace)) throw Error('filesystem world or resolved target mismatch')
        const info = await fs.stat(target, exec.signal)
        ticket.file = { fs, target, version: info?.version, consumed: false, initialIdentity: fileApprovalIdentity(exec, rootsFor(exec))! }
        if (fingerprint(exec) !== ticket.fingerprint) throw Error('file changed during version capture')
      }
      tickets.set(exec.token, ticket)
      if (!automatic && modelReview && review?.explanation === undefined) return { kind: 'deny', reason: '[auto-mode complete execution explanation required] operation did not execute' }
      const outcome = automatic ? 'allowed-once' : await approval!.request({
        agent: exec.agent, toolName: exec.name, callId: exec.callId,
        signal: callSignal,
        reason: review?.reason ?? assessment.reason,
        ...(review?.explanation === undefined ? {} : { review: { recommendation: 'execute' as const, ...review.explanation } }),
      })
      if (!active || exec.signal.aborted || outcome !== 'allowed-once') {
        return { kind: 'deny', reason: `[auto-mode manual approval ${outcome}] operation did not execute` }
      }
      if (authorityFor(exec) !== authority || fingerprint(exec) !== ticket.fingerprint) {
        return { kind: 'deny', reason: '[auto-mode approval changed] retry the exact current operation for a new decision' }
      }
      // Waiting for this human decision does not spend the execution window.
      // The immutable review and all current authority/file checks must still match.
      if (!automatic && review !== undefined) {
        if (review.fingerprint !== reviewFingerprint(exec)) return { kind: 'deny', reason: '[auto-mode approval context changed] operation did not execute' }
        review.expires = Date.now() + 120_000
      }
      const native = nativeCalls.get(exec.token)!
      exec.agent.session.append('approval/call-authorized', { callId: exec.callId, toolName: exec.name, fingerprint: ticket.fingerprint,
        approvedBy: ticket.approvedBy, workdir: native.workdir, mode: native.mode, provider: native.facts?.provider ?? 'structured-harness-tool' })
      ticket.approved = true
      return next()
    } catch {
      return { kind: 'deny', reason: '[auto-mode exact authorization unavailable] operation did not execute' }
    }
  })
  // Check again at dispatch. A guard runs once, while around-tool wrappers may retry next().
  ctx.on('tools/execute', async (exec, next) => {
    const initial = observed.get(exec.token)
    if (initial === undefined && authorityFor(exec) === undefined) return next()
    if (!active || exec.signal.aborted || dispatched.has(exec.token)) throw Error('Auto execution cancelled or replayed')
    const hardReason = hard(exec)
    if (hardReason !== undefined) throw Error(hardReason)
    if (!reviewMatches(exec)) throw Error('Auto model review changed before dispatch')
    if (initial !== undefined && (initial.authority !== authorityFor(exec) || initial.agent !== exec.agent || initial.presetHistory !== presetHistory(initial.authority))) throw Error('Auto authority changed before dispatch')
    const assessment = evaluate(exec)
    if (assessment.decision === 'deny') throw Error(assessment.reason)
    const ticket = tickets.get(exec.token)
    if ((assessment.decision === 'ask' || reviews.get(exec.token)?.decision === 'ask')
      && (!ticket?.guarded || ticket.fingerprint !== fingerprint(exec))) throw Error('Auto exact approval changed before dispatch')
    dispatched.add(exec.token)
    const review = reviews.get(exec.token)
    const finishAudit = review === undefined ? undefined : beginReviewAudit(rootsFor(exec).dshHome, {
      provider: review.provider, model: review.model, risk: review.risk, decision: review.decision,
      ...(review.reasoningEffort === undefined ? {} : { reasoningEffort: review.reasoningEffort }),
      fingerprint: review.fingerprint, approvedBy: ticket?.approvedBy ?? 'model',
      tool: exec.name, callId: exec.callId, sessionId: exec.agent?.session.header.id,
    })
    let outcome: 'success' | 'error' = 'error'
    try {
      const result = await next()
      outcome = result.isError ? 'error' : 'success'
      return result
    } finally { finishAudit?.(outcome) }
  })
  // Bind the approved edit to the official backend's conditional commit API.
  // This also prevents a trusted tool wrapper from spending one approval twice.
  const validateFileTicket = (target: FsTarget, actor: object | undefined) => {
    const exec = actor as Readonly<ToolExecution> | undefined
    if (exec === undefined || (authorityFor(exec) === undefined && !observed.has(exec.token))) return undefined
    const ticket = tickets.get(exec.token)
    if (!active || exec.signal.aborted || !ticket?.guarded || !ticket.file) throw Error('Auto file commit lacks exact approval')
    const reason = hard(exec)
    if (reason !== undefined) throw Error(reason)
    if (!reviewMatches(exec)) throw Error('Auto model review changed before file commit')
    if (ticket.authority !== authorityFor(exec) || ticket.agent !== exec.agent ||
      observed.get(exec.token)?.presetHistory !== presetHistory(ticket.authority)) throw Error('Auto file commit authority changed')
    const original = (value: object | undefined) => value === undefined ? undefined : Reflect.get(value, symbols.original) ?? value
    if (original(ticket.file.fs) !== original(ctx.get('fs'))) throw Error('Auto filesystem service changed')
    if (target.targetKey !== ticket.file.target.targetKey) throw Error('Auto filesystem target identity changed')
    if (ticket.fingerprint !== fingerprint(exec)) throw Error('Auto file content or arguments changed before commit')
    return ticket.file
  }
  ctx.on('fs/execution-policy', async (actor, policy, next) => {
    const exec = actor as ToolExecution
    if (authorityFor(exec) === undefined && !observed.has(exec.token)) return next()
    const ticket = tickets.get(exec.token)
    if (policy?.mode !== 'workspace-write' || ticket?.file === undefined) throw Error('Auto file policy is unavailable')
    validateFileTicket(ticket.file.target, exec)
    return { ...policy, workspaceRoot: structuredFilePath(exec, rootsFor(exec)) }
  }, { prepend: true })
  ctx.on('fs/read-snapshot', async (actor, target, next) => {
    const exec = actor as ToolExecution
    if (authorityFor(exec) === undefined && !observed.has(exec.token)) return next()
    const ticket = tickets.get(exec.token)
    if (!ticket?.guarded || !reviewMatches(exec) || ticket.fingerprint !== fingerprint(exec)) throw Error('Auto read authorization changed')
    const roots = rootsFor(exec)
    const path = structuredFilePath(exec, roots)
    if (normalizePath(ctx.fs.processPath(target), roots.workspace) !== normalizePath(path, roots.workspace)) throw Error('Auto read target changed')
    return readVerifiedFile(path, roots, fileApprovalIdentity(exec, roots)!)
  }, { prepend: true })
  const commitTicket = (target: FsTarget, actor: object | undefined) => {
    const file = validateFileTicket(target, actor)
    if (file?.consumed) throw Error('Auto file commit lacks unspent exact approval')
    if (file) file.consumed = true
    return file
  }
  ctx.on('fs/write-intent', async (target, actor, next) => {
    const prior = await next()
    const file = commitTicket(target, actor)
    if (!file) return prior
    if (prior && (prior.kind === 'createIfAbsent' ? file.version !== undefined : prior.version !== file.version)) throw Error('Auto approval conflicts with existing write policy')
    // The pinned provider reads these fields after outer intent listeners and
    // its per-target queue have settled. Recheck authority at that read as well.
    return file.version === undefined ? Object.freeze({
      get kind() { validateFileTicket(target, actor); return 'createIfAbsent' as const },
    }) : Object.freeze({
      get kind() { validateFileTicket(target, actor); return 'replaceIfVersion' as const },
      get version() { validateFileTicket(target, actor); return file.version! },
    })
  }, { prepend: true })
  ctx.on('fs/edit-intent', async (target, actor, next) => {
    const prior = await next()
    const file = commitTicket(target, actor)
    if (!file) return prior
    if (file.version === undefined || (prior && prior.version !== file.version)) throw Error('Auto edit requires the approved existing file version')
    return Object.freeze({ get version() { validateFileTicket(target, actor); return file.version! } })
  }, { prepend: true })
  installSearchPolicy(ctx, rootsFor, exec => observed.has(exec.token) || authorityFor(exec) !== undefined, exec => {
    const ticket = tickets.get(exec.token)
    if (!ticket?.guarded || !reviewMatches(exec) || ticket.fingerprint !== fingerprint(exec)) throw Error('Search approval changed')
  })
  ctx.inject(['fs'], scope => {
    registerManagedList(scope, rootsFor)
    registerManagedFile(scope, rootsFor, async exec => {
      const ticket = tickets.get(exec.token)
      if (!active || exec.signal.aborted || !ticket?.guarded || ticket.managedConsumed || !reviewMatches(exec)
        || ticket.fingerprint !== fingerprint(exec) || ticket.authority !== authorityFor(exec)
        || observed.get(exec.token)?.presetHistory !== presetHistory(ticket.authority)) throw Error('Exact file authorization changed')
      ticket.managedConsumed = true
      const reason = hard(exec)
      if (reason !== undefined || ticket.file === undefined) throw Error(reason ?? 'Reviewed file version is unavailable')
      const file = ticket.file
      return { fs: file.fs, target: file.target, version: file.version,
        revalidate: () => { if (validateFileTicket(file.target, exec) !== file) throw Error('Exact file authorization unavailable') },
        consume: () => { commitTicket(file.target, exec) } }
    }, disposal.signal, (exec, path, identity, created, previousIdentity) => {
      files.remember(exec, path, identity, created, previousIdentity)
      recordFileCommit(exec, path, identity, created)
    })
  })
  ctx.on('fs/observed', (target, observation, actor) => {
    const exec = actor as ToolExecution | undefined
    const ticket = exec === undefined ? undefined : tickets.get(exec.token)
    if (ticket?.file?.consumed && target.targetKey === ticket.file.target.targetKey && observation.kind === 'present') ticket.committedVersion = observation.version
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const ticket = tickets.get(exec.token)
    if (!result.isError && ticket && ['read', 'read_image'].includes(exec.name) && ticket.fingerprint !== fingerprint(exec)) throw Error('Read target changed after approval; results withheld')
    if (!result.isError && exec.name !== 'managed_file' && ticket?.file?.consumed && ticket.committedVersion !== undefined) {
      const path = structuredFilePath(exec, rootsFor(exec))
      const committed = inspectStructuredPath(path, rootsFor(exec), false, true)
      const info = await ticket.file.fs.stat(ticket.file.target, exec.signal)
      if (info?.version === ticket.committedVersion && sameFileAncestors(ticket.file.initialIdentity, committed.identity)
        && inspectStructuredPath(path, rootsFor(exec), false, true).identity === committed.identity) {
        files.remember(exec, path, committed.identity, ticket.file.version === undefined, ticket.file.initialIdentity)
        recordFileCommit(exec, path, committed.identity, ticket.file.version === undefined)
      }
    }
    if (authorityFor(exec) === undefined || !isRedundantSandboxResult(result) || decision.kind !== 'accept') return decision
    return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), redundantSandboxRetryContext()] }
  })
  ctx.on('tools/result', exec => { tickets.delete(exec.token); observed.delete(exec.token); dispatched.delete(exec.token); reviews.delete(exec.token); nativeCalls.delete(exec.token); preparedCalls.delete(exec.token) })
  ctx.provide('autoModeProtection', Object.freeze({ policy: 'preservation-v1' as const, enforceAllSessions: false, modelReview, epoch: randomUUID(), signal: disposal.signal }))
  // LIFO: revoke the published lifetime before any guard or file listener is removed.
  ctx.effect(() => () => { active = false; disposal.abort() }, 'auto-mode: revoke protection')
}
