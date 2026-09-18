/** Boot the materialized target runtime without access to a user's Harness profile. */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DesktopHostProcess } from '../src/host-process.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import { linkDesktopHostPackages, recordDesktopRuntimeProfile, validateDesktopPluginGraph } from '../src/profile-packages.ts'
import type { DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'

/**
 * Prove the final resource tree boots and serves its matching Web frontend.
 * @param root - Materialized dsh resources.
 * @param node - Prepared target Node executable.
 * @param runtime - Verified resource descriptor.
 * @param options - Fixture location and packaged ASAR resolution mode.
 */
export async function smokeDesktopRuntime(root: string, node: string, runtime: DesktopRuntimeDescriptor, options: {
  fixture?: string
  resolution?: 'link' | 'runtime'
  realReview?: boolean
  model?: string
} = {}): Promise<void> {
  for (const preset of ['read-only', 'workspace-write', 'danger-full-access', 'auto']) {
    await smokeDesktopPreset(root, node, runtime, options, preset)
  }
}

/** Verify each native preset and the Auto preset with the active workspace set to an isolated user home. */
async function smokeDesktopPreset(root: string, node: string, runtime: DesktopRuntimeDescriptor,
  options: { fixture?: string; resolution?: 'link' | 'runtime'; realReview?: boolean; model?: string }, preset: string): Promise<void> {
  if (options.realReview && !process.env.DEEPSEEK_API_KEY) throw new Error('Real review smoke requires DEEPSEEK_API_KEY in the test process environment')
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-desktop-smoke-')))
  const home = join(scratch, 'home')
  const profile = join(home, 'profiles', 'desktop')
  const effects = join(scratch, 'workspace')
  const tracePath = join(scratch, 'trace.jsonl')
  const donePath = join(scratch, 'done.json')
  const canary = join(home, 'protected-canary.txt')
  mkdirSync(home)
  mkdirSync(effects)
  writeFileSync(join(effects, 'existing.txt'), 'valuable')
  writeFileSync(join(effects, 'trash.txt'), 'recoverable')
  writeFileSync(canary, 'keep')
  const host = new DesktopHostProcess(node, root, profile, undefined, {
    ...process.env, HOME: effects, USERPROFILE: effects, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
    AUTO_FIXTURE_PRESET: preset,
    AUTO_FIXTURE_REAL_API: options.realReview ? '1' : '0',
    AUTO_FIXTURE_MODEL: options.model ?? 'deepseek-flash',
    AUTO_FIXTURE_EFFECTS: effects, AUTO_FIXTURE_TRACE: tracePath,
    AUTO_FIXTURE_DONE: donePath, AUTO_FIXTURE_PROTECTED: canary,
  })
  try {
    createPluginProfile(profile)
    const pluginName = 'desktop-runtime-smoke-plugin'
    const plugin = join(profile, 'node_modules', pluginName)
    mkdirSync(plugin, { recursive: true })
    const cordis = runtime.sharedPackages.find(entry => entry.name === '@deepseek-ai/cordis')
    if (cordis === undefined) throw new Error('desktop runtime: missing shared Cordis package')
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({
      name: pluginName, version: '1.0.0', type: 'module', exports: './index.js',
      peerDependencies: { '@deepseek-ai/cordis': cordis.version }, dsh: { bundle: { patch: './bundle.yml' } },
    }))
    writeFileSync(join(plugin, 'index.js'), `
import { Context } from '@deepseek-ai/cordis'
export function apply(ctx) {
  if (!(ctx instanceof Context)) throw new Error('desktop runtime: external plugin loaded another Cordis instance')
}
`)
    copyFileSync(options.fixture ?? fileURLToPath(new URL('../tests/fixtures/harness-runtime-llm.mjs', import.meta.url)), join(plugin, 'fixture.mjs'))
    writeFileSync(join(plugin, 'bundle.yml'), `
- id: llm-deepseek
  disabled: ${options.realReview ? 'false' : 'true'}
  ${options.realReview ? 'config: { protocol: messages, baseURL: https://api.deepseek.com/anthropic }' : ''}
- id: llm-pi-ai
  disabled: true
- id: session-title-llm
  disabled: true
- insert:
    - id: desktop-runtime-smoke-plugin
      name: desktop-runtime-smoke-plugin
    - id: desktop-official-auto-fixture
      name: desktop-runtime-smoke-plugin/fixture.mjs
`)
    const fixtureManifest = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')) as Record<string, unknown>
    fixtureManifest.exports = { '.': './index.js', './fixture.mjs': './fixture.mjs' }
    writeFileSync(join(plugin, 'package.json'), JSON.stringify(fixtureManifest))
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    manifest.dependencies[pluginName] = '1.0.0'
    manifest.dsh.profile.bundles.push(pluginName)
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
    const resolution = options.resolution ?? 'runtime'
    if (resolution === 'runtime') recordDesktopRuntimeProfile(profile, runtime)
    else linkDesktopHostPackages(profile, root, runtime)
    validateDesktopPluginGraph(profile, root, runtime, [pluginName], resolution)
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    const ready = await Promise.race([
      host.start(),
      new Promise<never>((_resolve, reject) => {
        timer = globalThis.setTimeout(() => { reject(new Error('desktop runtime: host smoke startup timed out')) }, options.realReview ? 270_000 : 90_000)
      }),
    ]).finally(() => { clearTimeout(timer) })
    if (ready.dshVersion !== runtime.release.version) throw new Error('desktop runtime: Host reported another dsh release')
    const response = await host.fetch(new Request('dsh-app://app/', { signal: AbortSignal.timeout(15_000) }))
    if (response.status !== 200 || !(await response.text()).includes('<html')) {
      throw new Error('desktop runtime: packaged frontend smoke failed')
    }
    const deadline = Date.now() + (options.realReview ? 240_000 : 75_000)
    while (!existsSync(donePath) && Date.now() < deadline) await setTimeout(100)
    if (!existsSync(donePath)) throw new Error('desktop runtime: official Auto fixture did not finish')
    const completion = JSON.parse(readFileSync(donePath, 'utf8')) as { completed?: boolean; error?: string }
    if (!completion.completed) throw new Error(`desktop runtime: official Auto fixture failed: ${completion.error}\n${existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : 'no trace'}`)
    const trace = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) as Array<Record<string, unknown>>
    const resultFor = (label: string): Record<string, unknown> | undefined => trace.find(event => event.event === 'tool-result' && event.label === label)
    const contents = (file: string): string | undefined => existsSync(join(effects, file)) ? readFileSync(join(effects, file), 'utf8') : undefined
    const auto = preset === 'auto'
    const expected = {
      read: false, glob: false, grep: false, 'edit-approved': false, 'write-approved': false, ordinary: false, present: false,
      ...(preset === 'read-only' ? { 'edit-sandbox-denied': true, 'write-sandbox-denied': true } : {}),
      ...(auto ? { 'external-write': false, 'external-read': false, 'external-remove': false, delegation: false, 'child-read': false,
        ...(!options.realReview ? { 'model-denied': true, 'model-error': true, 'model-invalid': true } : {}) } : {}),
    }
    const reviews = trace.filter(event => event.event === 'model-review')
    const session = trace.find(event => event.event === 'fixture-session')
    const manual = trace.filter(event => event.event === 'manual-approval')
    const requests = trace.filter(event => event.event === 'model-request')
    const results = trace.filter(event => event.event === 'tool-result')
    const readValue = resultFor('read')?.value as { lines?: Array<{ text: string }> } | undefined
    const globValue = resultFor('glob')?.value as { paths?: string[] } | undefined
    const grepValue = resultFor('grep')?.value as { matches?: Array<{ path: string; line: string }> } | undefined
    const delivery = trace.find(event => event.event === 'deliverables/presented')?.data as { files?: Array<{ path: string }> } | undefined
    const assertions = {
      toolsSettled: Object.entries(expected).every(([label, isError]) => resultFor(label)?.isError === isError),
      nativeDefault: session?.defaultPreset === 'workspace-write',
      fourChoices: JSON.stringify(session?.catalog) === JSON.stringify(['read-only', 'workspace-write', 'danger-full-access', 'auto']),
      noCustomPolicy: session?.customPolicyAbsent === true,
      homeWorkspace: session?.home === effects && session.cwd === effects,
      approvalPolicy: session?.approval === (auto || preset === 'danger-full-access' ? 'never' : 'ask'),
      reviewScope: auto ? reviews.length === results.length : reviews.length === 0,
      nativeToolsVisible: requests.every(event => ['read', 'glob', 'grep', 'present', 'subagent', process.platform === 'win32' ? 'pwsh' : 'bash'].every(name => (event.toolNames as string[]).includes(name))),
      noManagedTools: requests.every(event => !(event.toolNames as string[]).includes('managed_file') && !(event.toolNames as string[]).includes('managed_list')),
      noCustomGuidance: requests.every(event => event.autoGuidance === false),
      approvedEdit: contents('existing.txt') === 'approved',
      approvedCreate: contents('approved.txt') === 'approved new file',
      readContent: readValue?.lines?.some(line => line.text === 'valuable') === true,
      globFoundFile: globValue?.paths?.includes('existing.txt') === true,
      grepFoundContent: grepValue?.matches?.some(match => match.path === 'existing.txt' && match.line === 'valuable') === true,
      deliverableRecorded: delivery?.files?.some(file => file.path === join(effects, 'approved.txt')) === true,
      nativeCommandOutput: JSON.stringify(resultFor('ordinary')?.value).includes('OFFICIAL_AUTO_SHELL_OK'),
      ...(auto ? {
        childReviewed: resultFor('child-read')?.child === true && resultFor('child-read')?.preset === 'auto',
        externalRemoved: !existsSync(join(scratch, 'external.txt')),
        rejectedChangesAbsent: ['model-denied', 'model-error', 'model-invalid'].every(file => contents(`${file}.txt`) === undefined),
        noManualFallback: manual.length === 0,
        ...(!options.realReview ? { adapterDefaultReasoning: reviews.every(event => event.reasoningEffort === 'low') } : {}),
      } : { nativeApprovals: manual.length === (preset === 'read-only' ? 2 : 0) }),
      canaryUnchanged: readFileSync(canary, 'utf8') === 'keep',
    }
    if (!Object.values(assertions).every(Boolean)) {
      throw new Error(`desktop runtime: official Auto assertions failed: ${JSON.stringify({ assertions, trace })}`)
    }
    process.stdout.write(`desktop four-permission smoke: ${JSON.stringify({ realApi: options.realReview === true, preset, ...(options.realReview ? { model: options.model ?? 'deepseek-flash', reviews } : {}), assertions })}\n`)
  } finally {
    await host.stop()
    rmSync(scratch, { recursive: true, force: true })
  }
}
