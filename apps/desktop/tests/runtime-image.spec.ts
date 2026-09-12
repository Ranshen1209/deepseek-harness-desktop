import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { create } from 'tar'
import { createRuntimeImage, extractRuntimeImage, RUNTIME_IMAGE_ARCHIVE, RUNTIME_IMAGE_MANIFEST } from '../src/runtime-image.ts'

const roots: string[] = []
const execute = promisify(execFile)
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-image-'))
  roots.push(path)
  return path
}
function file(root: string, name: string, body: string): void {
  const path = join(root, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}
async function fixture(): Promise<string> {
  const seed = root()
  file(seed, 'node_modules/@deepseek-ai/dsh/package.json', '{"name":"@deepseek-ai/dsh","version":"1.0.0"}')
  file(seed, 'node_modules/@deepseek-ai/dsh-desktop-host/package.json', '{"name":"@deepseek-ai/dsh-desktop-host","type":"module"}')
  file(seed, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js', 'import { value } from "dependency"; export { value }')
  file(seed, 'node_modules/dependency/package.json', '{"name":"dependency","type":"module","exports":"./index.js"}')
  file(seed, 'node_modules/dependency/index.js', 'export const value = "relocated"')
  file(seed, 'node_modules/.modules.yaml', 'storeDir: /build-machine/private-store')
  await createRuntimeImage(seed, '1.0.0', process)
  return seed
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('preinstalled desktop runtime', () => {
  it('executes dependencies after deployment and relocation without the builder or pnpm store', async () => {
    const seed = await fixture()
    const destination = join(root(), 'staging')
    const progress: number[] = []
    await extractRuntimeImage(seed, destination, '1.0.0', (value) => { progress.push(value.completedBytes) })
    rmSync(join(seed, 'node_modules'), { recursive: true })
    const active = join(dirname(destination), 'active with spaces')
    renameSync(destination, active)
    const entry = pathToFileURL(join(active, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js')).href
    const result = await execute(process.execPath, ['--input-type=module', '-e', `console.log((await import(${JSON.stringify(entry)})).value)`])
    expect(result.stdout.trim()).toBe('relocated')
    expect(existsSync(join(active, 'node_modules/.modules.yaml'))).toBe(false)
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBe(readFileSync(join(seed, RUNTIME_IMAGE_ARCHIVE)).length)
  })

  it('rejects changed archive bytes and a descriptor for another platform or release', async () => {
    const seed = await fixture()
    await expect(extractRuntimeImage(seed, root(), '2.0.0')).rejects.toThrow(/descriptor/u)
    const path = join(seed, RUNTIME_IMAGE_MANIFEST)
    const image = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({ ...image, platform: 'other' }))
    await expect(extractRuntimeImage(seed, root(), '1.0.0')).rejects.toThrow(/descriptor/u)
    writeFileSync(path, JSON.stringify(image))
    const bytes = readFileSync(join(seed, RUNTIME_IMAGE_ARCHIVE))
    const payload = bytes.indexOf('relocated')
    expect(payload).toBeGreaterThan(0)
    bytes[payload] = 'R'.charCodeAt(0)
    writeFileSync(join(seed, RUNTIME_IMAGE_ARCHIVE), bytes)
    await expect(extractRuntimeImage(seed, root(), '1.0.0')).rejects.toThrow(/integrity/u)
  })

  it('packages a project reached through a directory alias', async () => {
    const seed = await fixture()
    const alias = join(root(), 'aliased seed')
    symlinkSync(seed, alias, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await createRuntimeImage(alias, '1.0.0', process)
      const destination = root()
      await extractRuntimeImage(alias, destination, '1.0.0')
      expect(readFileSync(join(destination, 'node_modules/dependency/index.js'), 'utf8')).toContain('relocated')
    } finally {
      unlinkSync(alias)
    }
  })

  it('refuses to unpack over an existing installation', async () => {
    const seed = await fixture()
    await expect(extractRuntimeImage(seed, seed, '1.0.0')).rejects.toThrow(/not empty/u)
  })

  it('deploys pnpm hardlinks independently of their original store', async () => {
    const seed = await fixture()
    const store = root()
    for (let index = 0; index < 48; index += 1) {
      const name = `linked-${String(index).padStart(2, '0')}`
      file(store, name, name.repeat(8192))
      linkSync(join(store, name), join(seed, 'node_modules', name))
      linkSync(join(store, name), join(seed, 'node_modules', `${name}-duplicate`))
    }
    await createRuntimeImage(seed, '1.0.0', process)
    rmSync(store, { recursive: true })
    const destination = root()
    await extractRuntimeImage(seed, destination, '1.0.0')
    expect(readFileSync(join(destination, 'node_modules/linked-47-duplicate'), 'utf8')).toBe('linked-47'.repeat(8192))
  })

  it('binds a cross-architecture build to the installed runtime instead of the build host', async () => {
    const seed = await fixture()
    const arch = process.arch === 'arm64' ? 'x64' : 'arm64'
    const descriptor = await createRuntimeImage(seed, '1.0.0', { platform: process.platform, arch })
    expect(descriptor.arch).toBe(arch)
    await expect(extractRuntimeImage(seed, root(), '1.0.0')).rejects.toThrow(/descriptor/u)
  })

  it('rejects a validly hashed archive that writes outside node_modules', async () => {
    const seed = await fixture()
    file(seed, 'unexpected', 'outside')
    await create({ cwd: seed, file: join(seed, RUNTIME_IMAGE_ARCHIVE) }, ['unexpected'])
    const bytes = readFileSync(join(seed, RUNTIME_IMAGE_ARCHIVE))
    const descriptor = JSON.parse(readFileSync(join(seed, RUNTIME_IMAGE_MANIFEST), 'utf8')) as Record<string, unknown>
    writeFileSync(join(seed, RUNTIME_IMAGE_MANIFEST), JSON.stringify({ ...descriptor, entries: 1, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }))
    const destination = root()
    await expect(extractRuntimeImage(seed, destination, '1.0.0')).rejects.toThrow(/invalid.*path/u)
    expect(existsSync(join(destination, 'unexpected'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('preserves relative executable links on macOS without builder paths', async () => {
    // POSIX bin links need no privileges; Windows pnpm creates ordinary .cmd shims instead.
    const seed = await fixture()
    mkdirSync(join(seed, 'node_modules/.bin'))
    symlinkSync('../dependency/index.js', join(seed, 'node_modules/.bin/dependency'))
    await createRuntimeImage(seed, '1.0.0', process)
    const destination = root()
    await extractRuntimeImage(seed, destination, '1.0.0')
    expect(readFileSync(join(destination, 'node_modules/.bin/dependency'), 'utf8')).toContain('relocated')
  })
})
