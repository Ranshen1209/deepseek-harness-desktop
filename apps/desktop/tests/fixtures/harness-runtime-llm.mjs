/** Deterministic tool driver; opt-in real review uses the official DeepSeek adapter. */
import { LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import { Session } from '@deepseek-ai/dsh-session'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const tracePath = process.env.AUTO_FIXTURE_TRACE
const root = process.env.AUTO_FIXTURE_EFFECTS
const realApi = process.env.AUTO_FIXTURE_REAL_API === '1'
if (!tracePath || !root) throw Error('Auto Mode product fixture requires its isolated runner')
const trace = value => appendFileSync(tracePath, JSON.stringify({ ...value, time: Date.now() }) + '\n')
const argumentsSha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const preset = process.env.AUTO_FIXTURE_PRESET
const auto = preset === 'auto'
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const print = marker => process.platform === 'win32' ? `Write-Output "${marker}"` : `printf '%s\\n' '${marker}'`
const commonPlan = [
  { label: 'read', name: 'read', args: { file_path: join(root, 'existing.txt') } },
  { label: 'glob', name: 'glob', args: { pattern: '*.txt', path: root } },
  { label: 'grep', name: 'grep', args: { pattern: 'valuable', path: root } },
  { label: 'edit-approved', name: 'edit', args: { file_path: join(root, 'existing.txt'), old_string: 'valuable', new_string: 'approved' } },
  { label: 'write-approved', name: 'write', args: { file_path: join(root, 'approved.txt'), content: 'approved new file' } },
  { label: 'ordinary', name: shell, args: { command: print('OFFICIAL_AUTO_SHELL_OK'), description: 'Print an isolated runtime marker', workdir: root } },
  { label: 'present', name: 'present', args: { files: [{ path: join(root, 'approved.txt'), description: 'Runtime fixture output' }] } },
]
const denialPlan = ['model-denied', 'model-error', 'model-invalid'].map(label => ({ label, name: 'write', args: { file_path: join(root, label + '.txt'), content: 'must not exist' } }))
const external = join(dirname(root), 'external.txt')
const parentPlan = auto ? [
  ...commonPlan,
  ...(!realApi ? denialPlan : []),
  { label: 'external-write', name: 'write', args: { file_path: external, content: 'official external test' } },
  { label: 'external-read', name: 'read', args: { file_path: external } },
  { label: 'external-remove', name: shell, args: { command: process.platform === 'win32' ? `Remove-Item -LiteralPath '${external.replaceAll("'", "''")}'` : `rm -- '${external.replaceAll("'", "'\\''")}'`, description: 'Remove only the file just created by this fixture', workdir: root } },
  { label: 'delegation', name: 'subagent', args: { description: 'Verify child native read', prompt: 'OFFICIAL_AUTO_CHILD: Read existing.txt once and finish. Do not modify files or delegate.', run_in_background: false } },
] : commonPlan.flatMap(step => preset === 'read-only' && ['edit-approved', 'write-approved'].includes(step.label)
  ? [{ ...step, label: step.label.replace('-approved', '-sandbox-denied') }, { ...step, args: { ...step.args, sandbox_permissions: 'workspace-write', justification: 'Allow this exact isolated write after the native read-only denial' } }]
  : [step])
const childPlan = [{ label: 'child-read', name: 'read', args: { file_path: join(root, 'existing.txt') } }]
const calls = new Map()
const steps = new Map()
let sequence = 0
const model = { provider: realApi ? 'deepseek-official' : 'auto-mode-fixture', id: realApi ? process.env.AUTO_FIXTURE_MODEL : 'deterministic', name: 'Auto Mode test route', context: { contextWindow: 262144 }, defaultMaxTokens: 8192, reasoning: { efforts: [{ id: 'low', name: 'low' }], defaultEffort: 'low' } }
function* textChunks(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
function* toolChunks(step) {
  const id = ToolCallId(`auto-fixture-${++sequence}-${step.label}`)
  calls.set(String(id), step.label)
  const args = JSON.stringify(step.args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name: step.name, argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.name, arguments: args } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
class FixtureAdapter extends LlmAdapter {
  async listModels() { return [model] }
  async resolveModel(provider, id) { return { ...model, provider, id } }
  async *stream(options) {
    options.signal?.throwIfAborted()
    if (options.system?.startsWith('REVIEW_POLICY\n')) {
      const text = options.messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
      const action = JSON.parse(text.split('PENDING_ACTION\n\n')[1])
      const mode = action.arguments?.file_path?.split(/[\\/]/).at(-1)
      const decision = mode === 'model-denied.txt' ? 'deny' : 'allow'
      trace({ event: 'model-review', action: action.name, file: mode, decision, provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort })
      if (mode === 'model-error.txt') throw Error('Synthetic review transport failure')
      yield* textChunks(mode === 'model-invalid.txt' ? '{"decision":"allow"}' : JSON.stringify({ risk: 'medium', decision, ...(decision === 'deny' ? { reason: 'Synthetic model refusal for an isolated fixture call.' } : {}) }))
      return
    }
    if (options.purpose) { yield* textChunks('Auto Mode fixture'); return }
    const directText = options.messages.filter(message => message.role === 'user').flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
    const child = directText.includes('OFFICIAL_AUTO_CHILD:')
    const key = `${String(options.sessionId)}:${child}`
    const index = steps.get(key) ?? 0
    const plan = child ? childPlan : parentPlan
    const step = plan[index]
    const bashSchema = options.tools?.find(tool => tool.name === 'bash')?.parameters
    trace({ event: 'model-request', sessionId: options.sessionId, child, step: step?.label ?? 'finish', cwdGuidance: options.system?.includes('/tmp'), autoGuidance: (String(options.system) + directText).includes('<auto_mode_policy>'), toolNames: (options.tools ?? []).map(tool => tool.name), bashHasSandboxField: Object.prototype.hasOwnProperty.call(bashSchema?.properties ?? {}, 'sandbox_permissions') })
    steps.set(key, index + 1)
    if (!step) { yield* textChunks(child ? 'AUTO_MODE_CHILD_PRODUCT_OK' : 'AUTO_MODE_PRODUCT_FIXTURE_OK'); return }
    if (!options.tools?.some(tool => tool.name === step.name)) throw Error(`Missing native tool ${step.name}`)
    yield* toolChunks(step)
  }
}
export const name = 'auto-mode-product-fixture'
export const inject = ['llm', 'tools', 'permissionPresets', 'agents', 'sessions', 'approval', 'sessionController', 'agentDefaultModel']
export async function apply(ctx) {
  if (realApi) {
    const driver = new FixtureAdapter()
    ctx.on('llm/stream', async function* (options, next) {
      if (!options.system?.startsWith('REVIEW_POLICY\n')) { yield* driver.stream(options); return }
      const started = Date.now()
      const input = options.messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
      const action = JSON.parse(input.split('PENDING_ACTION\n\n')[1])
      let text = '', finish
      for await (const chunk of next()) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'finish') finish = chunk.reason.kind
        yield chunk
      }
      trace({ event: 'model-review', action: action.name, argumentsSha256: argumentsSha256(action.arguments), provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort, elapsedMs: Date.now() - started, finish, response: text })
    })
  } else ctx.llm.registerAdapter(['auto-mode-fixture'], new FixtureAdapter())
  ctx.on('approval/request', async (request, next) => {
    const label = calls.get(String(request.callId))
    if (!label) return next()
    const outcome = label === 'write-rejected' ? 'rejected' : (!auto || label.endsWith('-approved') || ['ordinary', 'widening'].includes(label)) ? 'allowed-once' : 'rejected'
    trace({ event: 'manual-approval', label, toolName: request.toolName, reason: request.reason, review: request.review, outcome })
    return outcome
  }, { prepend: true })
  ctx.on('tools/result', (exec, result) => {
    const label = calls.get(String(exec.callId))
    if (!label) return
    trace({ event: 'tool-result', label, name: exec.name, argumentsSha256: argumentsSha256(exec.arguments), isError: result.isError, error: result.isError ? result.error?.message : undefined, value: !result.isError ? result.value : undefined, sessionId: exec.agent?.session.id, cwd: exec.agent?.session.header.cwd, child: exec.agent?.session.header.origin === 'subagent', sessionIdentityMatches: exec.agent?.session instanceof Session, preset: exec.agent ? ctx.permissionPresets.current(exec.agent.session) : undefined })
  })
  ctx.on('session/event', (session, event) => {
    if (['approval/asked', 'approval/decided', 'deliverables/presented'].includes(event.type)) trace({ event: event.type, sessionId: session.id, data: event.data })
  })
  await (async () => {
      await ctx.agentDefaultModel.saveSelection({ provider: model.provider, model: model.id })
      const { sessionId } = await ctx.sessionController.create({ cwd: root })
      const session = ctx.sessions.get(sessionId)
      if (!session) throw Error('Desktop fixture session was not created')
      const defaultPreset = ctx.permissionPresets.current(session)
      const catalog = ctx.permissionPresets.names
      const customPolicyAbsent = ctx.get('autoModeProtection') === undefined
      ctx.permissionPresets.set(session, process.env.AUTO_FIXTURE_PRESET)
      trace({ event: 'fixture-session', home: homedir(), cwd: session.header.cwd, defaultPreset, catalog, customPolicyAbsent, approval: ctx.approval.overrideOf(session) })
      await ctx.sessionController.selectModel({ sessionId, provider: model.provider, model: model.id })
      const abort = new AbortController()
      let release
      const completed = new Promise(resolve => { release = resolve })
      const stop = ctx.on('session/event', (session, event) => {
        if (session.id === sessionId && event.type === 'turn/end') release()
      })
      const timeout = setTimeout(() => { abort.abort(new Error('Desktop fixture timed out')); release() }, realApi ? 210000 : 60000)
      try {
        await ctx.sessionController.prompt({ sessionId, requestId: randomUUID(), mode: 'queue', content: [{
          type: 'text', text: `Verify this isolated packaged runtime: read and search existing.txt, change valuable to approved, create approved.txt with approved new file, print OFFICIAL_AUTO_SHELL_OK, and present approved.txt. In Auto also create ${external} with official external test, read it, then delete only that new file; delegate one read-only child check. Leave the pre-existing sentinel unchanged. This is a deterministic integration fixture, not a natural-language task acceptance.`,
        }] }, abort.signal)
        await completed
        abort.signal.throwIfAborted()
        writeFileSync(process.env.AUTO_FIXTURE_DONE, JSON.stringify({ completed: true, sessionId }))
      } finally { clearTimeout(timeout); stop() }
    })().catch(error => writeFileSync(process.env.AUTO_FIXTURE_DONE, JSON.stringify({ error: error.stack ?? String(error) })))
  trace({ event: 'fixture-activated', servicesMatchResolvedClasses: { llm: ctx.llm instanceof LlmRuntime, tools: ctx.tools instanceof ToolRuntime, permissionPresets: ctx.permissionPresets instanceof PermissionPresetService }, provider: model.provider, realApi, process: { pid: process.pid, cwd: process.cwd(), node: process.version } })
}
