/** Boot the deployed release image in an isolated home before producing an installer. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopHostProcess } from '../src/host-process.ts'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { parseDesktopRelease } from '../src/release.ts'
import { resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'

const build = resolveDesktopTargetBuildPaths()
const release = parseDesktopRelease(JSON.parse(readFileSync(join(build.seed, 'desktop-release.json'), 'utf8')))
const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-smoke-'))
const previousHome = process.env.DSH_HOME
const paths = resolveDesktopPaths(join(root, 'home'))
const node = join(build.runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
const manager = new DesktopProjectManager(paths, { node, pnpm: join(root, 'pnpm-must-not-run') })
const host = new DesktopHostProcess(node, paths.profile)
const began = performance.now()
const phases: Array<{ phase: string; elapsedMs: number }> = []
let timeout: ReturnType<typeof setTimeout> | undefined
try {
  process.env.DSH_HOME = join(root, 'home')
  const applied = await manager.applyRelease(build.seed, release.version, {
    healthCheck: async () => { throw new Error('first installation must use its actual startup for readiness') },
    beforeActivate: async () => { await host.stop() },
    afterActivate: async () => {
      const ready = await Promise.race([
        host.start(),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => { reject(new Error('desktop runtime did not become ready within 120 seconds')) }, 120_000) }),
      ])
      if (timeout !== undefined) clearTimeout(timeout)
      assert.equal(ready.dshVersion, release.version)
    },
  }, (phase) => {
    if (phases.at(-1)?.phase !== phase) phases.push({ phase, elapsedMs: Math.round(performance.now() - began) })
  })
  assert.equal(applied, true)
  const response = await host.fetch(new Request('dsh-app://app/index.html'))
  assert.equal(response.status, 200)
  assert.match(await response.text(), /<html/u)
  const elapsedMs = Math.round(performance.now() - began)
  mkdirSync(build.root, { recursive: true })
  writeFileSync(join(build.root, 'runtime-smoke.json'), `${JSON.stringify({ version: release.version, platform: process.platform,
    arch: process.arch, elapsedMs, phases, pnpmInvocations: 0, backendStarts: 1, indexStatus: response.status }, undefined, 2)}\n`)
  console.log(`Desktop runtime image booted and served the client in ${elapsedMs} ms without pnpm.`)
} finally {
  if (timeout !== undefined) clearTimeout(timeout)
  await host.stop()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(root, { recursive: true, force: true })
}
