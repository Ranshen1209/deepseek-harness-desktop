/** Exercise the final application executable, its ASAR resources and preservation policy. */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'

const execute = promisify(execFile)
const appRoot = resolve(import.meta.dirname, '..')
const target = process.argv[2]
if (target !== 'mac-arm64' && target !== 'win-x64') throw new Error('Pass mac-arm64 or win-x64')
const paths = desktopTargetBuildPaths(target)
const product = 'DeepSeek Harness'
let executable: string
let resources: string
if (target === 'mac-arm64') {
  const directory = join(paths.artifacts, 'mac-arm64')
  const application = readdirSync(directory).find(file => file.endsWith('.app'))
  if (application === undefined) throw new Error('Missing packaged macOS application')
  const bundle = join(directory, application)
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle])
  executable = join(bundle, 'Contents', 'MacOS', product)
  resources = join(bundle, 'Contents', 'Resources')
} else {
  const appDirectory = process.env.DSH_ACCEPTANCE_APP_DIRECTORY ?? join(paths.artifacts, 'win-unpacked')
  executable = join(appDirectory, `${product}.exe`)
  resources = join(appDirectory, 'resources')
}
let runner = join(import.meta.dirname, 'packaged-preservation-smoke.mjs')
if (!existsSync(runner)) {
  const { build } = await import('tsdown')
  const output = join(paths.root, 'smoke')
  await build({
    config: false,
    entry: { 'packaged-preservation-smoke': join(appRoot, 'tests/fixtures/packaged-preservation-smoke.ts') },
    outDir: output, format: ['esm'], platform: 'node', target: 'es2024',
    dts: false, deps: { alwaysBundle: [/.*/u] },
  })
  runner = join(output, 'packaged-preservation-smoke.mjs')
}
const bundledFixture = join(import.meta.dirname, 'harness-runtime-llm.mjs')
const result = await execute(executable, [
  runner,
  join(resources, 'app.asar', 'dsh'),
  existsSync(bundledFixture) ? bundledFixture : join(appRoot, 'tests/fixtures/harness-runtime-llm.mjs'),
], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: process.env.DSH_SMOKE_REAL_REVIEW === '1' ? 1_200_000 : 360_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
