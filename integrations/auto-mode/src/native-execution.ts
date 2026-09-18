import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ShellExecSpec, ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-shell-env'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { inspectStructuredPath, readVerifiedFile } from './file-boundary.js'
import { inspectDirectory } from './managed-list.js'
import { normalizePath, type PolicyRoots } from './paths.js'
import { sanitizeClassifierText } from './classifier.js'
import type { ExecutionFacts } from './upstream-review/index.js'

/** Same-process executor request; none of these objects come from model JSON. */
export interface ExecutionApprovalRequest {
  readonly agent: NonNullable<ToolExecution['agent']>
  readonly toolName: string
  readonly callId: ToolExecution['callId']
  readonly execution: {
    readonly token: symbol
    readonly parameters: unknown
    readonly provider: object
    readonly workdir: string
    readonly requestedMode: string
  }
}

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Read the reviewed file version without reopening a mutable path. @mode waterfall */
    'fs/read-snapshot'(actor: object, target: FsTarget, next: () => Promise<Uint8Array | undefined>): Promise<Uint8Array | undefined>
    /** Bind the resolved native command to its final launch. @mode waterfall */
    'shell/authorize'(actor: object, provider: ShellExecutor, spec: ShellExecSpec, next: () => Promise<ShellExecSpec>): Promise<ShellExecSpec>
    /** Resolve a reviewed file leaf without granting its neighbours. @mode waterfall */
    'fs/execution-policy'(actor: object, policy: SandboxExecutionPolicy | undefined, next: () => Promise<SandboxExecutionPolicy | undefined>): Promise<SandboxExecutionPolicy | undefined>

    /** Consume a prior exact call approval before the executor asks again. @mode waterfall */
    'approval/consume-execution'(req: ExecutionApprovalRequest, next: () => Promise<ApprovalOutcome | undefined>): Promise<ApprovalOutcome | undefined>
  }
}

/** Stable service identity across Cordis contextual proxies. */
export function original(value: object | undefined): unknown {
  return value === undefined ? undefined : Reflect.get(value, symbols.original) ?? value
}

/** Preparation facts and revalidation of the actual installed provider. */
export interface NativeExecution {
  readonly provider: object | undefined
  readonly workdir: string
  readonly mode: string
  readonly signal: AbortSignal
  readonly validateSpec?: (spec: ShellExecSpec, provider: object) => void
  readonly facts?: ExecutionFacts['execution']
  readonly validate: () => void
}

/** Resolve actual tools and provider capabilities before requesting approval; launch no command. */
export async function prepareNativeExecution(ctx: Context, exec: ToolExecution, roots: PolicyRoots, signal: AbortSignal): Promise<NativeExecution> {
  const tool = ctx.tools.get(exec.name, exec.agent)
  if (tool === undefined) throw Error('tool-unavailable')
  const execute = tool.execute
  const args = exec.arguments as Record<string, unknown>
  const command = exec.name === 'pwsh' || exec.name === 'bash'
  const search = exec.name === 'grep' || exec.name === 'glob'
  if (search && tool.fileSearchAccessVersion !== 1) throw Error('protected-native-search-unavailable')
  const provider = command ? ctx.get('shell') : ctx.get('fs')
  const subprocess = command || search ? ctx.get('subprocess') : undefined
  if ((command || search) && (subprocess === undefined || Reflect.get(subprocess, 'hostFileAccess') !== true)) throw Error('verified-host-process-provider-unavailable')
  const sandbox = command ? ctx.get('sandbox') : undefined
  const policyProvider = command ? ctx.get('sandboxPolicy') : undefined
  const mode = typeof args.sandbox_permissions === 'string' ? args.sandbox_permissions : 'workspace-write'
  const workdir = command && typeof args.workdir === 'string' ? resolve(roots.workspace, args.workdir) : roots.workspace
  let facts: ExecutionFacts['execution']
  let validateSpec: NativeExecution['validateSpec']
  let validateCommand = () => {}
  const entries: Array<{ path: string; identity: string }> = []
  const validate = () => {
    signal.throwIfAborted()
    const currentTool = ctx.tools.get(exec.name, exec.agent)
    if (currentTool !== tool || currentTool.execute !== execute) throw Error('execution tool provider changed')
    if (search && currentTool.fileSearchAccessVersion !== 1) throw Error('protected-native-search-unavailable')
    if (original(provider) !== original(command ? ctx.get('shell') : ctx.get('fs'))) throw Error('execution service changed')
    if (command && (original(subprocess) !== original(ctx.get('subprocess')) || original(sandbox) !== original(ctx.get('sandbox')))) throw Error('native execution backend changed')
    if ((command || search) && (original(subprocess) !== original(ctx.get('subprocess')) || Reflect.get(ctx.subprocess, 'hostFileAccess') !== true)) throw Error('native execution world changed')
    if (command && original(policyProvider) !== original(ctx.get('sandboxPolicy'))) throw Error('native execution policy provider changed')
    validateCommand()
    for (const entry of entries) if (inspectStructuredPath(entry.path, roots, false, true, true).identity !== entry.identity) throw Error('reviewed entry file changed')
  }
  if (command) {
    const shell = ctx.get('shell')
    const policy = ctx.get('sandboxPolicy')?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
    if (shell?.sandboxMode === undefined || sandbox === undefined || subprocess === undefined || policy === undefined) throw Error('native-sandbox-provider-unavailable')
    if (policy.mode !== 'workspace-write') throw Error('Auto requires the workspace-write execution policy; reselect Auto')
    if (Reflect.get(shell, 'launchGuardVersion') !== 1 || ctx.get('shellEnv') === undefined) throw Error('native-launch-authorization-unavailable')
    const preflight = Reflect.get(shell, 'preflight') as ((spec: ShellExecSpec) => Promise<{ mode: string; enforcement: string }>) | undefined
    if (typeof preflight !== 'function') throw Error('native-provider-preflight-unavailable')
    if (mode === 'danger-full-access' && Reflect.get(ctx.get('approval') ?? {}, 'executionApprovalVersion') !== 1) throw Error('single-call-sandbox-approval-unavailable')
    const resolveSpec = () => shell.resolve({ command: String(args.command), workdir,
      ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
      dshEnv: ctx.shellEnv.collect(exec), sandboxPolicy: { ...policy, mode: mode as 'workspace-write' | 'danger-full-access' }, signal })
    const spec = resolveSpec()
    const specKey = (value: ShellExecSpec) => JSON.stringify({ command: value.command, workdir: value.workdir,
      timeoutMs: value.timeoutMs, stdoutMaxBytes: value.stdoutMaxBytes, stdin: value.stdin, env: value.env, dshEnv: value.dshEnv, sandboxPolicy: value.sandboxPolicy })
    const expectedSpec = specKey(spec)
    const executionIdentity = Reflect.get(shell, 'executionIdentity') as (spec: ShellExecSpec) => string
    if (typeof executionIdentity !== 'function') throw Error('native-execution-identity-unavailable')
    const expectedProcess = executionIdentity.call(shell, spec)
    const environment = JSON.stringify(scrubbedParentEnv())
    const methods = [shell.resolve, shell.run, shell.start, preflight, executionIdentity]
    const expectedPolicy = JSON.stringify(policy)
    const directoryIdentity = inspectDirectory(workdir, roots).identity
    validateCommand = () => {
      if (JSON.stringify(scrubbedParentEnv()) !== environment) throw Error('native process environment changed')
      if (inspectDirectory(workdir, roots).identity !== directoryIdentity) throw Error('native working directory changed')
      const currentPolicy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
      if (JSON.stringify(currentPolicy) !== expectedPolicy) throw Error('native sandbox policy changed')
      const currentMethods = [shell.resolve, shell.run, shell.start, Reflect.get(shell, 'preflight'), Reflect.get(shell, 'executionIdentity')]
      if (methods.some((method, i) => method !== currentMethods[i])) throw Error('native executor implementation changed')
      if (specKey(resolveSpec()) !== expectedSpec || executionIdentity.call(shell, spec) !== expectedProcess) throw Error('native command configuration or environment changed')
    }
    validateSpec = (actual, actualProvider) => {
      validate()
      if (original(actualProvider) !== original(shell) || specKey(actual) !== expectedSpec
        || executionIdentity.call(shell, actual) !== expectedProcess) throw Error('native launch differs from the reviewed command')
    }
    if (normalizePath(spec.workdir, roots.workspace) !== normalizePath(workdir, roots.workspace)) throw Error('native-provider-workdir-mismatch')
    let prepared
    try { prepared = await preflight.call(shell, spec) }
    catch { throw Error('native-sandbox-initialization-failed') }
    const entryFiles: Array<{ path: string; content: string }> = []
    // Static script tokens are review facts only; dynamic expansion is left to
    // the model and native sandbox, never treated as an authorization grammar.
    const names = new Set(['package.json', 'pyproject.toml', 'Cargo.toml', 'Makefile'])
    for (const token of String(args.command).matchAll(/(?:^|[\s;|&])(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;|&]+))/g)) {
      const name = token[1] ?? token[2] ?? token[3]!
      if (/\.(?:ps1|sh|bash|py|js|mjs|cjs|ts)$/i.test(name) && !/[$%*?`]/.test(name)) names.add(name)
      if (names.size > 16) throw Error('entry-file-review-limit; narrow the command')
    }
    for (const name of names) {
      const path = resolve(workdir, name)
      if (!existsSync(path)) { entries.push({ path, identity: inspectStructuredPath(path, roots, false, true, true).identity }); continue }
      const file = inspectStructuredPath(path, roots, false, true)
      const bytes = readVerifiedFile(path, roots, file.identity)
      if (bytes.length > 64_000) throw Error('entry-file-review-limit; narrow the command working directory')
      if (inspectStructuredPath(path, roots, false, true).identity !== file.identity) throw Error('entry file changed while reading')
      entries.push({ path, identity: file.identity })
      entryFiles.push({ path, content: sanitizeClassifierText(bytes.toString('utf8')) })
    }
    facts = { provider: shell.constructor.name, workdir, mode, confinement: prepared.enforcement, entryFiles }
  }
  validate()
  return { provider, workdir, mode, signal, ...(validateSpec === undefined ? {} : { validateSpec }), ...(facts === undefined ? {} : { facts }), validate }
}
