/** Host-owned gates remain active across policy unload and replacement. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool, TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { installProtectionGate } from '../../desktop-host/src/protection.ts'

let ctx: Context | undefined
async function fixture() {
  ctx = new Context()
  installProtectionGate(ctx)
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  let calls = 0
  ctx.tools.register(defineTool({
    name: 'sentinel', description: 'In-memory sentinel', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
    async execute() { calls++; return {} },
  }))
  let epoch = 0
  const policy = async () => {
    const controller = new AbortController()
    const fork = ctx!.plugin({ name: 'test-protection', apply(scope: Context) {
      scope.effect(() => () => controller.abort(), 'policy stop')
      scope.provide('autoModeProtection', { policy: 'preservation-v1', enforceAllSessions: true, modelReview: true, epoch: String(++epoch), signal: controller.signal })
    } })
    await fork.await()
    return fork
  }
  const input = { name: 'sentinel', arguments: {}, callId: ToolCallId('sentinel-call'), signal: new AbortController().signal }
  return { ctx, policy, input, calls: () => calls, scheduler: ctx.tools[TOOL_RUNTIME_SCHEDULER] }
}
afterEach(async () => { await ctx?.fiber.dispose() })
it('blocks dispatch when the bundled policy is missing', async () => {
  const f = await fixture()
  expect((await f.ctx.tools.execute(f.input)).isError).toBe(true)
  expect(f.calls()).toBe(0)
})
it('allows a call while the same policy stays alive', async () => {
  const f = await fixture(); await f.policy()
  expect((await f.ctx.tools.execute(f.input)).isError).toBe(false)
  expect(f.calls()).toBe(1)
})
it.each([false, true])('rejects prepared calls after unload, reload=%s', async (reload) => {
  const f = await fixture(), policy = await f.policy()
  const prepared = await f.scheduler.prepare(f.input)
  expect(prepared.kind).toBe('dispatch')
  await policy.dispose()
  if (reload) await f.policy()
  const result = await f.scheduler.dispatch(prepared.exec)
  expect(result.result.isError).toBe(true)
  expect(f.calls()).toBe(0)
})
it.each([false, true])('cancels calls held by a downstream wrapper, replaced signal=%s', async (replace) => {
  const f = await fixture(), policy = await f.policy()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const blocked = new Promise<void>((resolve) => { release = resolve })
  f.ctx.on('tools/execute', async (exec, next) => {
    const prior = exec.signal
    if (replace) exec.signal = new AbortController().signal
    try { enter(); await blocked; return await next() }
    finally { exec.signal = prior }
  })
  const run = f.ctx.tools.execute(f.input)
  try {
    await entered
    await policy.dispose()
  } finally { release() }
  expect((await run).isError).toBe(true)
  expect(f.calls()).toBe(0)
})
