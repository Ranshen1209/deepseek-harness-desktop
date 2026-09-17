/** Exercise the shipped executors through a non-spawning subprocess fixture. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SandboxPwshExecutor from '@deepseek-ai/dsh-pwsh-sandbox'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import type { ShellExecutor, ShellExecSpec } from '@deepseek-ai/dsh-shell'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function fixture(family: 'pwsh' | 'bash') {
  const ctx = new Context(); contexts.push(ctx)
  const spawn = vi.fn(() => { throw Error('synthetic-spawn-observed') })
  ctx.provide('subprocess', { spawn, hostFileAccess: true } as never)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) } as never)
  let release!: () => void, entered!: () => void
  const arrived = new Promise<void>((resolve) => { entered = resolve })
  const wait = new Promise<void>((resolve) => { release = resolve })
  ctx.provide('sandbox', { confine: async () => { entered(); await wait; return { argv: ['synthetic-runner'], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] } } } as never)
  if (family === 'pwsh') await ctx.plugin(SandboxPwshExecutor).await()
  else await ctx.plugin(SandboxBashExecutor).await()
  return { executor: ctx.shell as ShellExecutor, spawn, arrived, release }
}

it.each(['pwsh', 'bash'] as const)('%s consumes authorization after confinement, immediately before the one spawn', async (family) => {
  const f = await fixture(family)
  let consumed = false
  const spec: ShellExecSpec = { ...f.executor.resolve({ command: 'synthetic command; never executed' }), beforeSpawn: () => {
    if (consumed) throw Error('grant-already-consumed')
    consumed = true
  } }
  const run = f.executor.run(spec)
  await f.arrived
  expect(consumed).toBe(false); expect(f.spawn).not.toHaveBeenCalled()
  f.release()
  await expect(run).rejects.toThrow('synthetic-spawn-observed')
  await expect(f.executor.run(spec)).rejects.toThrow('grant-already-consumed')
  expect(f.spawn).toHaveBeenCalledTimes(1)
})

it.each(['pwsh', 'bash'] as const)('%s cancellation during confinement reaches zero native spawns', async (family) => {
  const f = await fixture(family)
  const cancel = new AbortController(), beforeSpawn = vi.fn()
  const run = f.executor.start({ ...f.executor.resolve({ command: 'synthetic command', signal: cancel.signal }), beforeSpawn })
  await f.arrived; cancel.abort(); f.release()
  await expect(run).rejects.toThrow()
  expect(beforeSpawn).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled()
})

it.each(['pwsh', 'bash'] as const)('%s rechecks changed launch arguments after asynchronous confinement', async (family) => {
  const f = await fixture(family)
  const spec = f.executor.resolve({ command: 'reviewed command' })
  const identity = f.executor.executionIdentity(spec)
  spec.beforeSpawn = (actual) => { if (f.executor.executionIdentity(actual) !== identity) throw Error('launch-input-changed') }
  const run = f.executor.run(spec)
  await f.arrived; spec.env = { AUTO_REVIEW_SYNTHETIC_MARKER: 'changed' }; f.release()
  await expect(run).rejects.toThrow('launch-input-changed')
  expect(f.spawn).not.toHaveBeenCalled()
})
