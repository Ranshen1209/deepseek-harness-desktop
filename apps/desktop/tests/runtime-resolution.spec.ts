/** Desktop locks the exact inventory while rejecting missing or mismatched runtime packages. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { lockDesktopRuntimePackages } from '../../desktop-host/src/runtime-resolution.ts'
import type { ProfileResolutionGeneration } from '@deepseek-ai/dsh-app-boot'
import { runtimeFixture } from './runtime-fixture.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('locks exactly the inventory without mutating the profile dependency selection', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-resolution-'))
  roots.push(root)
  const runtime = runtimeFixture(root)
  const generation: ProfileResolutionGeneration = {
    profilesDir: join(root, 'profiles'), profileDir: join(root, 'profiles/desktop'), localPackageNames: ['external-plugin'],
    entries: runtime.sharedPackages.map(item => ({ ...item, packageDir: join(root, item.path), declarer: join(root, 'package.json'), scope: 'installation' })),
  }
  const locked = lockDesktopRuntimePackages(root, generation)
  expect(locked.lockedPackageNames).toEqual(runtime.sharedPackages.map(item => item.name))
  expect(locked.localPackageNames).toBe(generation.localPackageNames)
  expect(generation.lockedPackageNames).toBeUndefined()
  expect(() => lockDesktopRuntimePackages(root, { ...generation, entries: [] })).toThrow('does not match')
  expect(() => lockDesktopRuntimePackages(root, { ...generation, entries: generation.entries.map(item => ({ ...item, version: '0.0.0' })) })).toThrow('does not match')
  const write = (value: unknown) => { writeFileSync(join(root, 'desktop-runtime.json'), JSON.stringify(value)) }
  for (const item of [
    { ...runtime.sharedPackages[0], path: '../outside' },
    { ...runtime.sharedPackages[0], name: '../outside' },
  ]) {
    write({ ...runtime, sharedPackages: [item] })
    expect(() => lockDesktopRuntimePackages(root, generation)).toThrow('invalid shared package')
  }
  write({ ...runtime, sharedPackages: [runtime.sharedPackages[0], runtime.sharedPackages[0]] })
  expect(() => lockDesktopRuntimePackages(root, generation)).toThrow('duplicate')
  write({ sharedPackages: [] })
  expect(() => lockDesktopRuntimePackages(root, generation)).toThrow('missing shared package')
})
