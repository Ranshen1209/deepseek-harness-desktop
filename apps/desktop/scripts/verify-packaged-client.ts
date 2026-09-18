/** Boot the real Electron renderer with fresh and upgraded isolated profiles. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import { createPluginProfile } from '../src/project-manager.ts'

const executablePath = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Pass the packaged Electron executable path')
const output = process.argv[3] === undefined ? undefined : resolve(process.argv[3])
if (output !== undefined) mkdirSync(output, { recursive: true })
const results: Array<Record<string, unknown>> = []
let currentState: string | undefined
for (const scenario of ['fresh', 'legacy-core'] as const) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-client-boot-'))
  const home = join(scratch, 'home')
  const profile = join(home, 'profiles', 'desktop')
  createPluginProfile(profile)
  const oldPackage = join(profile, 'node_modules', '@deepseek-ai', 'dsh-api-remotes')
  if (scenario === 'legacy-core') {
    assert(currentState !== undefined)
    writeFileSync(join(profile, 'desktop-runtime-state.json'), currentState)
    mkdirSync(oldPackage, { recursive: true })
    writeFileSync(join(oldPackage, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-api-remotes', version: '0.0.0', type: 'module',
      exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' },
      dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-api-gateway'], immediately: true } },
    }))
    writeFileSync(join(oldPackage, 'index.js'), 'throw new Error("REGRESSION: obsolete Profile core executed")\n')
    writeFileSync(join(oldPackage, 'client.js'), 'throw new Error("REGRESSION: obsolete Profile client executed")\n')
  }
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  for (const key of Object.keys(env)) {
    if (/KEY|SECRET|TOKEN|PASSWORD|ELECTRON_RUN_AS_NODE|NODE_OPTIONS/iu.test(key)) delete env[key as keyof typeof env]
  }
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    app = await electron.launch({ executablePath, args: [`--user-data-dir=${join(scratch, 'electron')}`], env, timeout: 90_000 })
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(error.message) })
    await page.waitForURL('dsh-app://app/**', { timeout: 90_000 })
    await page.waitForFunction(() => {
      const body = document.body.innerText
      return body.includes('Failed to load plugins') || document.querySelector('[data-slot="root"]') !== null
    }, undefined, { timeout: 90_000 }).catch(async (error: unknown) => {
      process.stdout.write(`${await page.locator('body').innerText()}\n`)
      throw error
    })
    const text = await page.locator('body').innerText()
    if (output !== undefined) {
      writeFileSync(join(output, `${scenario}.txt`), text)
    }
    assert(!text.includes('Failed to load plugins'), text)
    assert(!text.includes('REGRESSION:'), text)
    assert.equal(await page.locator('[data-slot="root"]').count(), 1)
    assert.equal(await page.locator('[data-slot-error]').count(), 0)
    assert.equal(errors.length, 0, errors.join('\n'))
    const terminal = await page.evaluate(async () => {
      const response = await fetch('/api/terminal/list', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'client-boot', method: 'terminal/list', payload: { args: { sessionId: 'desktop-boot-test' } } }),
      })
      return { status: response.status, body: await response.text() }
    })
    assert.equal(terminal.status, 200, terminal.body)
    assert.deepEqual(JSON.parse(terminal.body).result, { ok: true, value: [] })
    currentState = readFileSync(join(profile, 'desktop-runtime-state.json'), 'utf8')
    if (scenario === 'legacy-core') assert(readFileSync(join(oldPackage, 'index.js'), 'utf8').includes('obsolete Profile core'))
    if (output !== undefined) {
      await page.screenshot({ path: join(output, `${scenario}.png`), timeout: 10_000 }).catch((error: unknown) => {
        process.stderr.write(`Optional screenshot unavailable: ${String(error)}\n`)
      })
    }
    const result = { scenario, mounted: true, terminal, oldCorePreserved: scenario === 'legacy-core', pageErrors: errors }
    results.push(result)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    await app?.close()
    rmSync(scratch, { recursive: true, force: true })
  }
}
if (output !== undefined) writeFileSync(join(output, 'client-boot.json'), `${JSON.stringify(results, null, 2)}\n`)
