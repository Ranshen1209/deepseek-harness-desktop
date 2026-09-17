/** Exercise the final application executable, its ASAR resources and preservation policy. */
import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'tsdown'
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
  executable = join(paths.artifacts, 'win-unpacked', `${product}.exe`)
  resources = join(paths.artifacts, 'win-unpacked', 'resources')
}
const output = join(paths.root, 'smoke')
await build({
  config: false,
  entry: { 'packaged-preservation-smoke': join(appRoot, 'tests/fixtures/packaged-preservation-smoke.ts') },
  outDir: output, format: ['esm'], platform: 'node', target: 'es2024',
  dts: false, deps: { alwaysBundle: [/.*/u] },
})
const result = await execute(executable, [
  join(output, 'packaged-preservation-smoke.mjs'),
  join(resources, 'app.asar', 'dsh'),
  join(appRoot, 'tests/fixtures/harness-runtime-llm.mjs'),
], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: process.env.DSH_SMOKE_REAL_REVIEW === '1' ? 600_000 : 150_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
