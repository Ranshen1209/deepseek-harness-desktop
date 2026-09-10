import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import {
  applyUpstreamMerge,
  buildConflictResolutionPrompt,
  classifyConflictedPaths,
  compareReleaseVersions,
  decideSyncOutcome,
  desktopTagForUpstream,
  hasConflictMarkers,
  isDesktopPackageScript,
  isOverlayPath,
  parseLsRemoteTags,
  parseMergeTreeNameOnly,
  restoreDesktopPackageScripts,
  selectNewestUpstreamTag,
  stripAiFence,
  versionFromReleaseTag,
} from './upstream-desktop-sync.ts'

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upstream-desktop-sync-'))
  fixtureRoots.push(root)
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'sync@example.com'])
  git(root, ['config', 'user.name', 'Sync Tests'])
  git(root, ['config', 'commit.gpgsign', 'false'])
  mkdirSync(join(root, 'no-hooks'))
  git(root, ['config', 'core.hooksPath', join(root, 'no-hooks')])
  return root
}

describe('upstream tag mapping', () => {
  it('maps a prerelease upstream tag onto desktop-v with the same suffix', () => {
    expect(versionFromReleaseTag('dsh-v0.1.5-rc.1')).toBe('0.1.5-rc.1')
    expect(desktopTagForUpstream('dsh-v0.1.5-rc.1')).toBe('desktop-v0.1.5-rc.1')
    expect(versionFromReleaseTag('desktop-v0.1.5-rc.1')).toBe('0.1.5-rc.1')
    expect(versionFromReleaseTag('v0.1.5')).toBeUndefined()
    expect(versionFromReleaseTag('dsh-vnot-a-version')).toBeUndefined()
  })

  it('orders dsh-v tags by SemVer, not lexicographic tag text', () => {
    expect(compareReleaseVersions('0.1.10', '0.1.9')).toBeGreaterThan(0)
    expect(compareReleaseVersions('0.1.5', '0.1.5-rc.1')).toBeGreaterThan(0)
    expect(compareReleaseVersions('0.1.5-rc.1', '0.1.5-alpha.2')).toBeGreaterThan(0)
    expect(selectNewestUpstreamTag([
      'dsh-v0.1.9',
      'other',
      'dsh-v0.1.10',
      'dsh-v0.1.10-rc.1',
    ])).toBe('dsh-v0.1.10')
  })

  it('drops peeled ls-remote rows', () => {
    expect(parseLsRemoteTags([
      'abc\trefs/tags/dsh-v0.1.5-rc.1',
      'def\trefs/tags/dsh-v0.1.5-rc.1^{}',
      'ghi\trefs/tags/desktop-v0.1.5-rc.1',
    ].join('\n'))).toEqual(['dsh-v0.1.5-rc.1', 'desktop-v0.1.5-rc.1'])
  })
})

describe('overlay ownership', () => {
  it('keeps unsigned-release workflows and icons, not the whole Electron tree', () => {
    expect(isOverlayPath('.github/workflows/desktop-release.yml')).toBe(true)
    expect(isOverlayPath('.github/workflows/upstream-desktop-sync.yml')).toBe(true)
    expect(isOverlayPath('apps/desktop/build/icon.svg')).toBe(true)
    expect(isOverlayPath('apps/desktop/src/menu.ts')).toBe(true)
    expect(isOverlayPath('scripts/upstream-desktop-sync.ts')).toBe(true)
    expect(isOverlayPath('apps/desktop/src/main.ts')).toBe(false)
    expect(isOverlayPath('package.json')).toBe(false)
    expect(classifyConflictedPaths([
      '.github/workflows/desktop-release.yml',
      'apps/desktop/src/main.ts',
    ])).toEqual({
      overlay: ['.github/workflows/desktop-release.yml'],
      remaining: ['apps/desktop/src/main.ts'],
    })
  })

  it('restores missing desktop package scripts without taking ours for every key', () => {
    const ours = {
      scripts: {
        test: 'vitest run',
        'generate:desktop-icons': 'pnpm --filter @deepseek-ai/dsh-desktop run generate:icons',
        'upload:mac:arm64': 'pnpm --filter @deepseek-ai/dsh-desktop run upload:mac:arm64',
      },
    }
    const merged = {
      scripts: {
        test: 'vitest run --coverage',
        build: 'tsx scripts/build.ts',
      },
    }
    expect(restoreDesktopPackageScripts(ours, merged)).toEqual({
      scripts: {
        test: 'vitest run --coverage',
        build: 'tsx scripts/build.ts',
        'generate:desktop-icons': 'pnpm --filter @deepseek-ai/dsh-desktop run generate:icons',
        'upload:mac:arm64': 'pnpm --filter @deepseek-ai/dsh-desktop run upload:mac:arm64',
      },
    })
    expect(isDesktopPackageScript('test')).toBe(false)
  })
})

describe('sync outcome', () => {
  it('never publishes a desktop tag when a non-overlay conflict occurred', () => {
    expect(decideSyncOutcome({
      desktopTagExists: false,
      alreadyImported: false,
      needsHumanReview: true,
      defaultBranchUpdated: true,
    })).toBe('pull_request')
    expect(decideSyncOutcome({
      desktopTagExists: false,
      alreadyImported: false,
      needsHumanReview: false,
      defaultBranchUpdated: false,
    })).toBe('pull_request')
    expect(decideSyncOutcome({
      desktopTagExists: true,
      alreadyImported: false,
      needsHumanReview: false,
      defaultBranchUpdated: true,
    })).toBe('skipped')
    expect(decideSyncOutcome({
      desktopTagExists: false,
      alreadyImported: true,
      needsHumanReview: false,
      defaultBranchUpdated: true,
    })).toBe('skipped')
    expect(decideSyncOutcome({
      desktopTagExists: false,
      alreadyImported: false,
      needsHumanReview: false,
      defaultBranchUpdated: true,
    })).toBe('published')
  })
})

describe('merge-tree parse and AI helpers', () => {
  it('reads the result tree and conflicted paths from NUL output', () => {
    const stdout = [
      'abc123',
      '.github/workflows/desktop-release.yml',
      'apps/desktop/src/main.ts',
      '',
      '1',
      'apps/desktop/src/main.ts',
      'CONFLICT (contents)',
      'CONFLICT (content): Merge conflict in apps/desktop/src/main.ts\n',
    ].join('\0')
    expect(parseMergeTreeNameOnly(stdout, 1)).toEqual({
      tree: 'abc123',
      conflictedPaths: ['.github/workflows/desktop-release.yml', 'apps/desktop/src/main.ts'],
      status: 1,
    })
  })

  it('strips an outer fence and keeps conflict-marker detection strict', () => {
    expect(stripAiFence('```ts\nexport const x = 1\n```')).toBe('export const x = 1')
    expect(hasConflictMarkers('<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> tag\n')).toBe(true)
    expect(hasConflictMarkers('const x = 1\n')).toBe(false)
    expect(buildConflictResolutionPrompt('pkg.json', '<<<<<<< HEAD\n')).toContain('Path: pkg.json')
  })
})

describe('applyUpstreamMerge', () => {
  it('restores overlay deletions and takes upstream for other files', { timeout: 20_000 }, () => {
    const root = repo()
    write(join(root, 'shared.txt'), 'base shared\n')
    write(join(root, '.github/workflows/desktop-release.yml'), 'name: Desktop release\n')
    write(join(root, 'package.json'), `${JSON.stringify({ scripts: { test: 'vitest', 'generate:desktop-icons': 'icons' } }, null, 2)}\n`)
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'root'])
    const base = git(root, ['rev-parse', 'HEAD'])

    git(root, ['checkout', '-b', 'theirs'])
    write(join(root, 'shared.txt'), 'upstream shared\n')
    write(join(root, 'package.json'), `${JSON.stringify({ scripts: { test: 'vitest --coverage', build: 'tsx' } }, null, 2)}\n`)
    git(root, ['rm', '-f', '.github/workflows/desktop-release.yml'])
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'upstream'])
    git(root, ['tag', 'dsh-v0.1.9'])

    git(root, ['checkout', 'main'])
    write(join(root, '.github/workflows/desktop-release.yml'), 'name: Desktop release\nunsigned: true\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'desktop overlay'])

    const applied = applyUpstreamMerge(root, base, 'dsh-v0.1.9')
    expect(applied.needsHumanReview).toBe(false)
    expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe('upstream shared\n')
    expect(readFileSync(join(root, '.github/workflows/desktop-release.yml'), 'utf8')).toContain('unsigned: true')
    const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts.test).toBe('vitest --coverage')
    expect(scripts.build).toBe('tsx')
    expect(scripts['generate:desktop-icons']).toBe('icons')
  })

  it('flags a non-overlay content conflict for human review and never treats it as clean', { timeout: 20_000 }, () => {
    const root = repo()
    write(join(root, 'apps/desktop/src/main.ts'), 'base main\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'root'])
    const base = git(root, ['rev-parse', 'HEAD'])

    git(root, ['checkout', '-b', 'theirs'])
    write(join(root, 'apps/desktop/src/main.ts'), 'upstream main\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'upstream'])
    git(root, ['tag', 'dsh-v0.2.0'])

    git(root, ['checkout', 'main'])
    write(join(root, 'apps/desktop/src/main.ts'), 'desktop main\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'desktop edit'])

    const applied = applyUpstreamMerge(root, base, 'dsh-v0.2.0')
    expect(applied.needsHumanReview).toBe(true)
    expect(applied.remainingConflictPaths).toContain('apps/desktop/src/main.ts')
    expect(hasConflictMarkers(readFileSync(join(root, 'apps/desktop/src/main.ts'), 'utf8'))).toBe(true)
    expect(decideSyncOutcome({
      desktopTagExists: false,
      alreadyImported: false,
      needsHumanReview: applied.needsHumanReview,
      defaultBranchUpdated: true,
    })).toBe('pull_request')
  })
})

describe('upstream-desktop-sync workflow', () => {
  it('polls on a schedule, accepts a manual tag, and leaves desktop-release.yml to packaging', () => {
    const workflow = load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/upstream-desktop-sync.yml'), 'utf8')) as {
      on: { schedule: Array<{ cron: string }>; workflow_dispatch: { inputs: { upstream_tag: unknown } } }
      permissions: Record<string, string>
      concurrency: { group: string; 'cancel-in-progress': boolean }
      jobs: { sync: { steps: Array<{ uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }> } }
    }
    expect(workflow.on.schedule[0]?.cron).toBe('17 */6 * * *')
    expect(workflow.on.workflow_dispatch.inputs.upstream_tag).toBeTruthy()
    expect(workflow.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' })
    expect(workflow.concurrency).toEqual({ group: 'upstream-desktop-sync', 'cancel-in-progress': false })
    const checkout = workflow.jobs.sync.steps.find(step => step.uses === 'actions/checkout@v6')
    expect(checkout?.with?.['fetch-depth']).toBe(0)
    expect(String(checkout?.with?.token)).toContain('DESKTOP_SYNC_TOKEN')
    expect(String(checkout?.with?.token)).toContain('github.token')
    const sync = workflow.jobs.sync.steps.find(step => step.run?.includes('upstream-desktop-sync.ts'))
    expect(sync?.run).toContain('scripts/upstream-desktop-sync.ts')
    expect(sync?.env?.ANTHROPIC_API_KEY).toBe('${{ secrets.ANTHROPIC_API_KEY }}')
    expect(sync?.env?.OPENAI_API_KEY).toBe('${{ secrets.OPENAI_API_KEY }}')
    const release = load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/desktop-release.yml'), 'utf8')) as {
      on: { push: { tags: string[] } }
    }
    expect(release.on.push.tags).toEqual(['desktop-v*'])
  })
})
