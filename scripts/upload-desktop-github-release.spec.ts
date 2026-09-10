import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import {
  classifyReleaseViewStatus,
  collectDesktopReleaseAssets,
  installerKindsForRequire,
  isDesktopGithubReleaseAsset,
  missingDesktopReleaseAssetKinds,
  releaseCreateFailedBecauseExists,
  runUploadDesktopGithubRelease,
} from './upload-desktop-github-release.ts'

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function artifacts(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-github-release-'))
  fixtureRoots.push(root)
  return root
}

function write(root: string, relative: string, content = 'installer'): void {
  const abs = join(root, relative)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

describe('desktop GitHub Release asset selection', () => {
  it('accepts electron-builder installers and rejects nested helper binaries', () => {
    expect(isDesktopGithubReleaseAsset(
      'desktop-macos-arm64/deepseek-harness-0.1.3-alpha.3-mac-arm64.dmg',
      ['dmg', 'zip', 'exe'],
    )).toBe(true)
    expect(isDesktopGithubReleaseAsset(
      'desktop-windows-x64/deepseek-harness-0.1.3-alpha.3-win-x64.exe',
      ['dmg', 'zip', 'exe'],
    )).toBe(true)
    expect(isDesktopGithubReleaseAsset(
      'desktop-windows-x64/fastlist-0.3.0-x64.exe',
      ['dmg', 'zip', 'exe'],
    )).toBe(false)
    expect(isDesktopGithubReleaseAsset(
      'desktop-windows-x64/win-unpacked/deepseek-harness-0.1.3-alpha.3-win-x64.exe',
      ['dmg', 'zip', 'exe'],
    )).toBe(false)
    expect(isDesktopGithubReleaseAsset(
      'desktop-macos-arm64/deepseek-harness-0.1.3-alpha.3-mac-arm64.zip.blockmap',
      ['dmg', 'zip', 'exe'],
    )).toBe(false)
    expect(installerKindsForRequire('win')).toEqual(['exe'])
  })

  it('fails a combined publish when macOS or Windows installers are absent', () => {
    const root = artifacts()
    write(root, 'desktop-windows-x64/deepseek-harness-0.1.5-rc.1-win-x64.exe')
    write(root, 'desktop-windows-x64/fastlist-0.3.0-x64.exe')
    const selected = collectDesktopReleaseAssets(root, installerKindsForRequire('mac-win'))
    expect(selected).toEqual([join(root, 'desktop-windows-x64/deepseek-harness-0.1.5-rc.1-win-x64.exe')])
    expect(missingDesktopReleaseAssetKinds(selected, 'mac-win')).toEqual(['dmg or zip'])
    expect(missingDesktopReleaseAssetKinds(selected, 'win')).toEqual([])
  })
})

describe('GitHub Release create/reuse', () => {
  it('reuses an existing Release and clobbers installer uploads', () => {
    expect(classifyReleaseViewStatus(0, '')).toBe('exists')
    expect(classifyReleaseViewStatus(1, 'release not found')).toBe('missing')
    expect(classifyReleaseViewStatus(1, 'HTTP 404: Not Found')).toBe('missing')
    expect(classifyReleaseViewStatus(1, 'HTTP 403: Resource not accessible by integration')).toBe('error')
    expect(releaseCreateFailedBecauseExists('HTTP 422: Validation Failed\nalready_exists')).toBe(true)
    expect(releaseCreateFailedBecauseExists('Release.tag_name already exists')).toBe(true)
    expect(releaseCreateFailedBecauseExists('HTTP 422: ReleaseAsset.name already exists')).toBe(false)
  })

  it('creates a missing Release then uploads only selected installers', () => {
    const root = artifacts()
    write(root, 'desktop-macos-arm64/deepseek-harness-0.1.5-rc.1-mac-arm64.dmg')
    write(root, 'desktop-macos-arm64/deepseek-harness-0.1.5-rc.1-mac-arm64.zip')
    write(root, 'desktop-windows-x64/deepseek-harness-0.1.5-rc.1-win-x64.exe')
    write(root, 'desktop-windows-x64/fastlist-0.3.0-x64.exe')
    const calls: string[][] = []
    const uploaded = runUploadDesktopGithubRelease([
      '--tag', 'desktop-v0.1.5-rc.1',
      '--repo', 'Ranshen1209/deepseek-harness-desktop',
      '--artifacts', root,
      '--require', 'mac-win',
    ], {
      gh: (args) => {
        calls.push(args)
        if (args[0] === 'release' && args[1] === 'view') {
          return { status: 1, stdout: '', stderr: 'release not found' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
      log: () => {},
    })
    expect(uploaded.map(path => path.split(/[/\\]/u).at(-1))).toEqual([
      'deepseek-harness-0.1.5-rc.1-mac-arm64.dmg',
      'deepseek-harness-0.1.5-rc.1-mac-arm64.zip',
      'deepseek-harness-0.1.5-rc.1-win-x64.exe',
    ])
    expect(calls.some(args => args[0] === 'release' && args[1] === 'create')).toBe(true)
    const upload = calls.find(args => args[0] === 'release' && args[1] === 'upload')
    expect(upload).toContain('--clobber')
    expect(upload?.some(arg => arg.includes('fastlist'))).toBe(false)
  })

  it('uploads when create races with an already-created Release', () => {
    const root = artifacts()
    write(root, 'desktop-windows-x64/deepseek-harness-0.1.3-alpha.3-win-x64.exe')
    const calls: string[][] = []
    runUploadDesktopGithubRelease([
      '--tag', 'desktop-windows-v0.1.3-alpha.3',
      '--repo', 'Ranshen1209/deepseek-harness-desktop',
      '--artifacts', root,
      '--require', 'win',
    ], {
      gh: (args) => {
        calls.push(args)
        if (args[1] === 'view') return { status: 1, stdout: '', stderr: 'release not found' }
        if (args[1] === 'create') {
          return { status: 1, stdout: '', stderr: 'HTTP 422: Validation Failed\nalready_exists' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
      log: () => {},
    })
    expect(calls.some(args => args[1] === 'upload' && args.includes('--clobber'))).toBe(true)
  })

  it('skips create when the Release already exists and still uploads', () => {
    const root = artifacts()
    write(root, 'desktop-windows-x64/deepseek-harness-0.1.3-alpha.3-win-x64.exe')
    const calls: string[][] = []
    runUploadDesktopGithubRelease([
      '--tag', 'desktop-windows-v0.1.3-alpha.3',
      '--repo', 'Ranshen1209/deepseek-harness-desktop',
      '--artifacts', root,
      '--require', 'win',
      '--prerelease',
    ], {
      gh: (args) => {
        calls.push(args)
        return { status: 0, stdout: 'https://github.com/example/releases/tag/x', stderr: '' }
      },
      log: () => {},
    })
    expect(calls.some(args => args[1] === 'create')).toBe(false)
    expect(calls.some(args => args[1] === 'upload' && args.includes('--clobber'))).toBe(true)
  })

  it('refuses to publish when no installer matched', () => {
    const root = artifacts()
    write(root, 'desktop-windows-x64/fastlist-0.3.0-x64.exe')
    expect(() => runUploadDesktopGithubRelease([
      '--tag', 'desktop-v0.1.3-alpha.3',
      '--repo', 'Ranshen1209/deepseek-harness-desktop',
      '--artifacts', root,
      '--require', 'mac-win',
    ], { gh: () => ({ status: 0, stdout: '', stderr: '' }) })).toThrow(/missing installer files/u)
  })
})

describe('desktop release workflows', () => {
  it('publishes through the installer uploader and keeps tag-push as the human entry', () => {
    const combined = load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/desktop-release.yml'), 'utf8')) as {
      jobs: { release: { steps: Array<{ uses?: string; run?: string }> } }
    }
    const windows = load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/desktop-windows-release.yml'), 'utf8')) as {
      jobs: { release: { steps: Array<{ run?: string }> } }
    }
    const combinedRun = combined.jobs.release.steps.find(step => step.run?.includes('upload-desktop-github-release.ts'))
    const windowsRun = windows.jobs.release.steps.find(step => step.run?.includes('upload-desktop-github-release.ts'))
    expect(combined.jobs.release.steps.some(step => step.uses === 'actions/checkout@v6')).toBe(true)
    expect(combinedRun?.run).toContain('--require mac-win')
    expect(windowsRun?.run).toContain('--require win')
    expect(windowsRun?.run).toContain('--prerelease')
    expect(combinedRun?.run).not.toContain('xargs')
    expect(windowsRun?.run).not.toContain('xargs')
  })
})
