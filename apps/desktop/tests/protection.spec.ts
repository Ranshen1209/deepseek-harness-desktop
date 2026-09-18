/** Upgrade admission never replaces the official Auto reviewer. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool, TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { installLegacyPermissionGate } from '../../desktop-host/src/protection.ts'

let ctx: Context | undefined
async function fixture() {
  ctx = new Context()
  let mode = 'workspace-write'
  ctx.provide('permissionPresets', { current: () => mode } as never)
  installLegacyPermissionGate(ctx)
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  let calls = 0
  ctx.tools.register(defineTool({
    name: 'sentinel', description: 'In-memory sentinel', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
    async execute() { calls++; return {} },
  }))
  const input = { agent: { session: {} } as never, name: 'sentinel', arguments: {}, callId: ToolCallId('sentinel-call'), signal: new AbortController().signal }
  return { ctx, input, setMode(value: string) { mode = value }, calls: () => calls, scheduler: ctx.tools[TOOL_RUNTIME_SCHEDULER] }
}
afterEach(async () => { await ctx?.fiber.dispose() })
it.each(['read-only', 'workspace-write', 'danger-full-access', 'auto'])('does not add a custom Auto policy to %s', async (mode) => {
  const f = await fixture(); f.setMode(mode)
  expect((await f.ctx.tools.execute(f.input)).isError).toBe(false)
  expect(f.calls()).toBe(1)
})
it.each(['custom', 'preservation'])('requires reselection for %s without executing', async (mode) => {
  const f = await fixture(); f.setMode(mode)
  expect((await f.ctx.tools.execute(f.input)).isError).toBe(true)
  expect(f.calls()).toBe(0)
  f.setMode('workspace-write')
  expect((await f.ctx.tools.execute(f.input)).isError).toBe(false)
  expect(f.calls()).toBe(1)
})
it('checks an inconsistent selection again at dispatch', async () => {
  const f = await fixture()
  const prepared = await f.scheduler.prepare(f.input)
  if (prepared.kind !== 'dispatch') throw Error('missing prepared execution')
  f.setMode('custom')
  expect((await f.scheduler.dispatch(prepared.exec)).result.isError).toBe(true)
  expect(f.calls()).toBe(0)
})
