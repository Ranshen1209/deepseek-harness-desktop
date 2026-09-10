/**
 * Import an upstream `dsh-v*` tag into this desktop copy and, when the merge is
 * clean, push `desktop-v*` so `.github/workflows/desktop-release.yml` publishes.
 *
 * This repository does not share Git history with `deepseek-ai/deepseek-harness`.
 * Each sync therefore names an explicit merge-base (the last imported upstream
 * tag, or this repository's root commit) and restores overlay paths that exist
 * only in the desktop copy. A conflicted or AI-resolved import never creates a
 * `desktop-v*` tag; it opens a draft pull request.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, TextDecoder } from 'node:util'

const UTF8 = new TextDecoder('utf-8', { fatal: true })
const MAX_GIT_OUTPUT = 64 * 1024 * 1024
const UPSTREAM_REPO_DEFAULT = 'deepseek-ai/deepseek-harness'
const UPSTREAM_TAG_PREFIX = 'dsh-v'
const DESKTOP_TAG_PREFIX = 'desktop-v'
const SYNC_BRANCH_PREFIX = 'sync/upstream-'
const UPSTREAM_TAG_TRAILER = 'Upstream-Tag'
const CONFLICT_MARKER = /^<<<<<<<($| )/m
const AI_FILE_CHAR_LIMIT = 80_000

/**
 * Paths this desktop copy owns. The merge restores them from HEAD when upstream
 * deleted or rewrote them. `apps/desktop/**` is not on this list: upstream also
 * ships the Electron shell, so those files take a normal three-way merge.
 */
const OVERLAY_PATHS = new Set([
  '.github/workflows/desktop-release.yml',
  '.github/workflows/desktop-windows-release.yml',
  '.github/workflows/upstream-desktop-sync.yml',
  '.github/verify-desktop-version.mjs',
  '.agents/notes/implemented/architecture/2026-09-09-unsigned-desktop-releases.md',
  '.agents/notes/implemented/architecture/2026-09-09-unsigned-desktop-releases.zh.md',
  '.agents/notes/implemented/architecture/2026-09-09-unsigned-desktop-releases.i18n.yaml',
  'apps/desktop/build/icon.svg',
  'apps/desktop/build/icon.png',
  'apps/desktop/build/icon.ico',
  'apps/desktop/build/icon.icns',
  'apps/desktop/scripts/generate-icons.mjs',
  'apps/desktop/src/menu.ts',
  'apps/desktop/tests/menu.spec.ts',
  'apps/desktop/tests/expected/menu-win32-en-US.json',
  'apps/desktop/tests/expected/menu-win32-zh-CN.json',
  'apps/desktop/tests/macos-signature.spec.ts',
  'scripts/upstream-desktop-sync.ts',
  'scripts/upstream-desktop-sync.spec.ts',
  'scripts/upload-desktop-github-release.ts',
  'scripts/upload-desktop-github-release.spec.ts',
])

/** Parsed `MAJOR.MINOR.PATCH` with an optional prerelease identifier list. */
export interface ReleaseNumbers {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

/** How one sync run finishes. `published` is the only outcome that pushes a tag. */
export type SyncOutcome = 'skipped' | 'published' | 'pull_request'

/** Inputs that decide whether this run may push `desktop-v*`. */
export interface SyncDecisionInput {
  /** True when origin already has `desktop-v{version}`. */
  desktopTagExists: boolean
  /** True when the default branch already records this upstream tag. */
  alreadyImported: boolean
  /** True when a non-overlay path still conflicted after overlay restore. */
  needsHumanReview: boolean
  /** True when the default branch accepted a fast-forward of the sync commit. */
  defaultBranchUpdated: boolean
}

/** Result of `git merge-tree --write-tree -z --name-only`. */
export interface MergeTreeResult {
  tree: string
  conflictedPaths: string[]
  status: number
}

/** Local merge after overlay restore and desktop script repair. */
export interface AppliedMerge {
  conflictedPaths: string[]
  overlayRestored: string[]
  remainingConflictPaths: string[]
  needsHumanReview: boolean
}

/** Optional GitHub and HTTP adapters so tests do not talk to the network. */
export interface SyncHost {
  gh?: (args: string[]) => { status: number; stdout: string; stderr: string }
  fetch?: typeof fetch
  log?: (message: string) => void
}

/** CLI options after `parseArgs`. */
export interface SyncCliOptions {
  cwd: string
  upstreamRepo: string
  upstreamTag: string | undefined
  defaultBranch: string
  dryRun: boolean
}

const invokedPath = process.argv[1]

/**
 * Normalize a repository-relative path to `/` separators.
 * @param path - Path from Git or the index.
 * @returns POSIX-style relative path.
 */
export function normalizeRepoPath(path: string): string {
  return path.replaceAll('\\', '/')
}

/**
 * Report whether this desktop copy should keep `path` on conflict or deletion.
 * @param path - Repository-relative path.
 * @returns True for overlay-owned paths, including this sync script family.
 */
export function isOverlayPath(path: string): boolean {
  const normalized = normalizeRepoPath(path)
  if (OVERLAY_PATHS.has(normalized)) return true
  return normalized.startsWith('scripts/upstream-desktop-sync')
    || normalized.startsWith('scripts/upload-desktop-github-release')
}

/**
 * Report whether a root `package.json` script key is a desktop packaging command.
 * @param name - Script key.
 * @returns True when the key is a desktop package, generate, or upload command.
 */
export function isDesktopPackageScript(name: string): boolean {
  return name.includes('desktop') || name.startsWith('upload:mac:') || name.startsWith('upload:win:')
}

/**
 * Parse a `dsh-v*` or `desktop-v*` tag into a version suffix.
 * @param tag - Git tag name.
 * @returns Version suffix such as `0.1.5-rc.1`, or `undefined` when the tag does not match.
 */
export function versionFromReleaseTag(tag: string): string | undefined {
  const match = /^(?:dsh|desktop)-v(.+)$/.exec(tag)
  if (match === undefined || match === null) return undefined
  const version = match[1]
  if (version === undefined || parseReleaseNumbers(version) === undefined) return undefined
  return version
}

/**
 * Map an upstream `dsh-v*` tag to the desktop tag that should trigger packaging.
 * @param upstreamTag - Tag such as `dsh-v0.1.5-rc.1`.
 * @returns `desktop-v` plus the same semver suffix.
 */
export function desktopTagForUpstream(upstreamTag: string): string {
  const version = versionFromReleaseTag(upstreamTag)
  if (version === undefined) throw new Error(`not an upstream dsh-v* tag: ${upstreamTag}`)
  if (!upstreamTag.startsWith(UPSTREAM_TAG_PREFIX)) throw new Error(`not an upstream dsh-v* tag: ${upstreamTag}`)
  return `${DESKTOP_TAG_PREFIX}${version}`
}

/**
 * Split a semver string, including a prerelease segment, into comparable parts.
 * @param version - Version without a `dsh-v` / `desktop-v` prefix.
 * @returns Parsed numbers, or `undefined` when the string is not a release version.
 */
export function parseReleaseNumbers(version: string): ReleaseNumbers | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (match === null) return undefined
  const prerelease = match[4] === undefined || match[4] === '' ? [] : match[4].split('.')
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Compare two release versions using SemVer 2.0 precedence.
 * @param left - Version without a tag prefix.
 * @param right - Version without a tag prefix.
 * @returns Negative when `left` is lower, positive when higher, zero when equal.
 */
export function compareReleaseVersions(left: string, right: string): number {
  const parsedLeft = parseReleaseNumbers(left)
  const parsedRight = parseReleaseNumbers(right)
  if (parsedLeft === undefined) throw new Error(`cannot parse release version ${left}`)
  if (parsedRight === undefined) throw new Error(`cannot parse release version ${right}`)
  if (parsedLeft.major !== parsedRight.major) return parsedLeft.major - parsedRight.major
  if (parsedLeft.minor !== parsedRight.minor) return parsedLeft.minor - parsedRight.minor
  if (parsedLeft.patch !== parsedRight.patch) return parsedLeft.patch - parsedRight.patch
  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) return 0
  if (parsedLeft.prerelease.length === 0) return 1
  if (parsedRight.prerelease.length === 0) return -1
  const limit = Math.min(parsedLeft.prerelease.length, parsedRight.prerelease.length)
  for (let index = 0; index < limit; index += 1) {
    const leftId = parsedLeft.prerelease[index]
    const rightId = parsedRight.prerelease[index]
    if (leftId === undefined || rightId === undefined) break
    const delta = compareIdentifiers(leftId, rightId)
    if (delta !== 0) return delta
  }
  return parsedLeft.prerelease.length - parsedRight.prerelease.length
}

/**
 * Pick the highest SemVer `dsh-v*` tag.
 * @param tags - Candidate tag names.
 * @returns The newest matching tag, or `undefined` when none match.
 */
export function selectNewestUpstreamTag(tags: string[]): string | undefined {
  const matching = tags.filter(tag => versionFromReleaseTag(tag) !== undefined && tag.startsWith(UPSTREAM_TAG_PREFIX))
  if (matching.length === 0) return undefined
  matching.sort((left, right) => {
    const leftVersion = versionFromReleaseTag(left)
    const rightVersion = versionFromReleaseTag(right)
    if (leftVersion === undefined || rightVersion === undefined) return 0
    return compareReleaseVersions(leftVersion, rightVersion)
  })
  return matching[matching.length - 1]
}

/**
 * Parse `git ls-remote --tags` lines into tag names, dropping peeled `^{}` rows.
 * @param stdout - `git ls-remote` text.
 * @returns Tag names without `refs/tags/`.
 */
export function parseLsRemoteTags(stdout: string): string[] {
  const tags: string[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trimEnd()
    if (trimmed === '') continue
    const tab = trimmed.lastIndexOf('\t')
    const ref = tab === -1 ? trimmed : trimmed.slice(tab + 1)
    if (!ref.startsWith('refs/tags/')) continue
    if (ref.endsWith('^{}')) continue
    tags.push(ref.slice('refs/tags/'.length))
  }
  return tags
}

/**
 * Parse `git merge-tree --write-tree -z --name-only` stdout.
 * @param stdout - NUL-separated merge-tree payload.
 * @param status - Process exit status (`0` clean, `1` conflicts).
 * @returns Resulting tree OID and conflicted paths.
 */
export function parseMergeTreeNameOnly(stdout: Buffer | string, status: number): MergeTreeResult {
  const raw = typeof stdout === 'string' ? Buffer.from(stdout) : stdout
  const parts: string[] = []
  let start = 0
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0) continue
    parts.push(UTF8.decode(raw.subarray(start, index)))
    start = index + 1
  }
  if (start < raw.length) parts.push(UTF8.decode(raw.subarray(start)))
  const tree = parts[0]
  if (tree === undefined || tree === '') throw new Error('merge-tree did not write a result tree')
  const conflictedPaths: string[] = []
  for (const part of parts.slice(1)) {
    if (part === '') break
    if (part.includes('\n') || part === '1' || part.startsWith('CONFLICT') || part.startsWith('Auto-merging')) break
    conflictedPaths.push(normalizeRepoPath(part))
  }
  return { tree, conflictedPaths: [...new Set(conflictedPaths)], status }
}

/**
 * Split merge-tree conflicted paths into overlay restores versus human review.
 * @param conflictedPaths - Paths merge-tree reported.
 * @returns Overlay-owned paths and every other conflicted path.
 */
export function classifyConflictedPaths(conflictedPaths: string[]): { overlay: string[]; remaining: string[] } {
  const overlay: string[] = []
  const remaining: string[] = []
  for (const path of conflictedPaths) {
    if (isOverlayPath(path)) overlay.push(path)
    else remaining.push(path)
  }
  return { overlay, remaining }
}

/**
 * Copy desktop packaging scripts from ours into a merged root manifest.
 * @param ours - `package.json` from HEAD before the import.
 * @param merged - `package.json` after applying the upstream tree.
 * @returns Merged manifest with missing desktop script keys restored.
 */
export function restoreDesktopPackageScripts(ours: unknown, merged: unknown): unknown {
  if (!isRecord(ours) || !isRecord(merged)) return merged
  const oursScripts = ours.scripts
  const mergedScripts = merged.scripts
  if (!isRecord(oursScripts) || !isRecord(mergedScripts)) return merged
  const scripts: Record<string, unknown> = { ...mergedScripts }
  for (const [name, command] of Object.entries(oursScripts)) {
    if (isDesktopPackageScript(name) && scripts[name] === undefined) scripts[name] = command
  }
  return { ...merged, scripts }
}

/**
 * Decide whether this run may push `desktop-v*`.
 * @param input - Idempotency and conflict flags after the local merge.
 * @returns `published` only for a clean import that updated the default branch.
 */
export function decideSyncOutcome(input: SyncDecisionInput): SyncOutcome {
  if (input.desktopTagExists || input.alreadyImported) return 'skipped'
  if (input.needsHumanReview || !input.defaultBranchUpdated) return 'pull_request'
  return 'published'
}

/**
 * Strip a wrapping markdown fence from a model response.
 * @param text - Raw model text.
 * @returns File contents without an outer ``` fence.
 */
export function stripAiFence(text: string): string {
  const trimmed = text.trim()
  const match = /^```(?:\w+)?\n([\s\S]*?)\n```$/.exec(trimmed)
  return match?.[1] ?? trimmed
}

/**
 * Build the user prompt that asks a model to finish one conflicted file.
 * @param path - Repository-relative path.
 * @param content - File bytes that still contain conflict markers.
 * @returns Prompt text.
 */
export function buildConflictResolutionPrompt(path: string, content: string): string {
  return [
    'Resolve the git merge conflict markers in this file.',
    'Ours is the DeepSeek Harness desktop copy (Ranshen1209/deepseek-harness-desktop).',
    'Theirs is upstream deepseek-ai/deepseek-harness.',
    'Keep desktop-only Electron packaging, unsigned-release workflows, and icon/menu files when both sides changed them.',
    'Keep upstream product behavior for every other path.',
    'Return only the complete resolved file. Do not wrap it in markdown fences. Do not leave <<<<<<< ======= >>>>>>> markers.',
    `Path: ${path}`,
    '',
    content,
  ].join('\n')
}

/**
 * Report whether file text still contains a merge conflict marker.
 * @param content - File text.
 * @returns True when a `<<<<<<<` line remains.
 */
export function hasConflictMarkers(content: string): boolean {
  return CONFLICT_MARKER.test(content)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defaultLog(message: string): void {
  process.stdout.write(`${message}\n`)
}

function spawnGit(cwd: string, args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LANG: 'C', LC_ALL: 'C' },
    input,
    maxBuffer: MAX_GIT_OUTPUT,
  })
  return {
    status: result.status ?? 1,
    stdout: decodeOutput(result.stdout, 'git stdout'),
    stderr: decodeOutput(result.stderr, 'git stderr'),
  }
}

function spawnGitBytes(cwd: string, args: string[]): { status: number; stdout: Buffer; stderr: string } {
  const result = spawnSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LANG: 'C', LC_ALL: 'C' },
    maxBuffer: MAX_GIT_OUTPUT,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: decodeOutput(result.stderr, 'git stderr'),
  }
}

function decodeOutput(output: Buffer | string | null | undefined, label: string): string {
  if (output === null || output === undefined) return ''
  if (typeof output === 'string') return output
  try {
    return UTF8.decode(output)
  } catch {
    throw new Error(`${label} is not valid UTF-8`)
  }
}

function requireGit(cwd: string, args: string[], context: string, input?: string): string {
  const result = spawnGit(cwd, args, input)
  if (result.status !== 0) {
    throw new Error(`${context}: ${result.stderr.trim() || result.stdout.trim() || `git exited ${String(result.status)}`}`)
  }
  return result.stdout
}

function parseCli(args: string[]): SyncCliOptions {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      cwd: { type: 'string' },
      'upstream-repo': { type: 'string' },
      'upstream-tag': { type: 'string' },
      'default-branch': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  })
  return {
    cwd: resolve(values.cwd ?? process.cwd()),
    upstreamRepo: values['upstream-repo'] ?? process.env.DSH_DESKTOP_SYNC_UPSTREAM_REPO ?? UPSTREAM_REPO_DEFAULT,
    upstreamTag: emptyToUndefined(values['upstream-tag'] ?? process.env.DSH_DESKTOP_SYNC_UPSTREAM_TAG),
    defaultBranch: values['default-branch']
      ?? process.env.DSH_DESKTOP_SYNC_DEFAULT_BRANCH
      ?? 'main',
    dryRun: values['dry-run'] === true,
  }
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return value.trim()
}

/**
 * List overlay paths present on `oursRef`.
 * @param cwd - Repository root.
 * @param oursRef - Commit that currently owns the overlay.
 * @returns Overlay paths that exist in that commit.
 */
export function listOverlayPathsOnRef(cwd: string, oursRef: string): string[] {
  const stdout = requireGit(cwd, ['ls-tree', '-r', '--name-only', '-z', oursRef], 'cannot list overlay paths')
  const paths: string[] = []
  for (const path of stdout.split('\0')) {
    if (path !== '' && isOverlayPath(path)) paths.push(path)
  }
  return paths
}

/**
 * Apply `git merge-tree` then restore overlay files and desktop package scripts.
 * @param cwd - Repository root whose HEAD is ours.
 * @param mergeBase - Commit used as the three-way ancestor.
 * @param theirs - Upstream tag or commit.
 * @returns Conflict classification after deterministic overlay restore.
 */
export function applyUpstreamMerge(cwd: string, mergeBase: string, theirs: string): AppliedMerge {
  const ours = requireGit(cwd, ['rev-parse', 'HEAD'], 'cannot resolve HEAD').trim()
  const merge = spawnGitBytes(cwd, [
    'merge-tree',
    '--write-tree',
    '-z',
    '--name-only',
    `--merge-base=${mergeBase}`,
    ours,
    theirs,
  ])
  if (merge.status !== 0 && merge.status !== 1) {
    throw new Error(`merge-tree failed: ${merge.stderr.trim() || `git exited ${String(merge.status)}`}`)
  }
  const parsed = parseMergeTreeNameOnly(merge.stdout, merge.status)
  const reset = spawnGit(cwd, ['read-tree', '-u', '--reset', parsed.tree])
  if (reset.status !== 0) throw new Error(`cannot apply merge tree: ${reset.stderr.trim()}`)
  const overlayRestored = listOverlayPathsOnRef(cwd, ours)
  if (overlayRestored.length > 0) {
    requireGit(cwd, ['checkout', ours, '--', ...overlayRestored], 'cannot restore overlay paths')
  }
  restoreRootDesktopScripts(cwd, ours)
  const remainingConflictPaths = findWorktreeConflictPaths(cwd).filter(path => !isOverlayPath(path))
  const classified = classifyConflictedPaths(parsed.conflictedPaths)
  const needsHumanReview = classified.remaining.length > 0 || remainingConflictPaths.length > 0
  return {
    conflictedPaths: parsed.conflictedPaths,
    overlayRestored,
    remainingConflictPaths: [...new Set([...classified.remaining, ...remainingConflictPaths])].sort(),
    needsHumanReview,
  }
}

function restoreRootDesktopScripts(cwd: string, ours: string): void {
  const manifestPath = resolve(cwd, 'package.json')
  if (!existsSync(manifestPath)) return
  const mergedText = readFileSync(manifestPath, 'utf8')
  if (hasConflictMarkers(mergedText)) return
  const oursText = requireGit(cwd, ['show', `${ours}:package.json`], 'cannot read ours package.json')
  let oursJson: unknown
  let mergedJson: unknown
  try {
    oursJson = JSON.parse(oursText)
    mergedJson = JSON.parse(mergedText)
  } catch (error) {
    if (error instanceof SyntaxError) return
    throw error
  }
  const restored = restoreDesktopPackageScripts(oursJson, mergedJson)
  writeFileSync(manifestPath, `${JSON.stringify(restored, null, 2)}\n`)
}

/**
 * Find tracked files whose worktree contents still contain conflict markers.
 * @param cwd - Repository root.
 * @returns Repository-relative paths.
 */
export function findWorktreeConflictPaths(cwd: string): string[] {
  const stdout = requireGit(cwd, ['ls-files', '-z'], 'cannot list tracked files')
  const conflicted: string[] = []
  for (const path of stdout.split('\0')) {
    if (path === '') continue
    const abs = resolve(cwd, path)
    if (!existsSync(abs)) continue
    const content = readFileSync(abs)
    if (content.includes(0)) continue
    if (hasConflictMarkers(content.toString('utf8'))) conflicted.push(path)
  }
  return conflicted
}

/**
 * Read `Upstream-Tag` trailers from commits reachable from `ref`.
 * @param cwd - Repository root.
 * @param ref - Commit to start from.
 * @returns Trailer values such as `dsh-v0.1.5-rc.1`.
 */
export function readImportedUpstreamTags(cwd: string, ref: string): string[] {
  const result = spawnGit(cwd, ['log', '-n', '50', '--format=%B', ref])
  if (result.status !== 0) return []
  const tags: string[] = []
  const pattern = new RegExp(`^${UPSTREAM_TAG_TRAILER}:\\s*(${UPSTREAM_TAG_PREFIX}\\S+)\\s*$`, 'gm')
  for (const match of result.stdout.matchAll(pattern)) {
    const tag = match[1]
    if (tag !== undefined) tags.push(tag)
  }
  return tags
}

/**
 * Resolve the three-way ancestor for this import.
 * @param cwd - Repository root.
 * @param headRef - Ours commit.
 * @param requestedTheirs - Upstream tag being imported.
 * @returns Merge-base commit OID or tag name Git can resolve.
 */
export function resolveSyntheticMergeBase(cwd: string, headRef: string, requestedTheirs: string): string {
  const imported = readImportedUpstreamTags(cwd, headRef)
  for (const tag of imported) {
    if (tag === requestedTheirs) continue
    const resolved = spawnGit(cwd, ['rev-parse', '--verify', `${tag}^{commit}`])
    if (resolved.status === 0) return resolved.stdout.trim()
  }
  const root = requireGit(cwd, ['rev-list', '--max-parents=0', headRef], 'cannot resolve repository root').trim()
  const roots = root.split('\n').filter(Boolean)
  if (roots.length === 1 && roots[0] !== undefined) return roots[0]
  throw new Error(`cannot choose a unique repository root for merge-base (found ${String(roots.length)})`)
}

async function resolveConflictsWithAi(
  cwd: string,
  paths: string[],
  host: SyncHost,
): Promise<{ attempted: boolean; unresolved: string[] }> {
  const anthropicKey = emptyToUndefined(process.env.ANTHROPIC_API_KEY)
  const openaiKey = emptyToUndefined(process.env.OPENAI_API_KEY)
  if (anthropicKey === undefined && openaiKey === undefined) {
    return { attempted: false, unresolved: paths }
  }
  const fetchImpl = host.fetch ?? fetch
  const unresolved: string[] = []
  for (const path of paths) {
    const abs = resolve(cwd, path)
    if (!existsSync(abs)) {
      unresolved.push(path)
      continue
    }
    const original = readFileSync(abs)
    if (original.includes(0) || original.length > AI_FILE_CHAR_LIMIT) {
      unresolved.push(path)
      continue
    }
    const text = original.toString('utf8')
    const prompt = buildConflictResolutionPrompt(path, text)
    try {
      let resolved: string
      if (anthropicKey !== undefined) {
        resolved = await completeAnthropic(fetchImpl, anthropicKey, prompt)
      } else if (openaiKey !== undefined) {
        resolved = await completeOpenAi(fetchImpl, openaiKey, prompt)
      } else {
        unresolved.push(path)
        continue
      }
      const stripped = stripAiFence(resolved)
      if (stripped === '' || hasConflictMarkers(stripped)) {
        unresolved.push(path)
        continue
      }
      writeFileSync(abs, stripped.endsWith('\n') ? stripped : `${stripped}\n`)
    } catch (error) {
      host.log?.(`AI resolution failed for ${path}: ${error instanceof Error ? error.message : String(error)}`)
      unresolved.push(path)
    }
  }
  return { attempted: true, unresolved }
}

async function completeAnthropic(fetchImpl: typeof fetch, apiKey: string, prompt: string): Promise<string> {
  const model = process.env.DSH_DESKTOP_SYNC_ANTHROPIC_MODEL ?? 'claude-sonnet-4-5'
  const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16_000,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`Anthropic HTTP ${String(response.status)}: ${body.slice(0, 500)}`)
  const parsed: unknown = JSON.parse(body)
  if (!isRecord(parsed) || !Array.isArray(parsed.content)) throw new Error('Anthropic response missing content')
  const text = parsed.content
    .filter(isRecord)
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('')
  if (text === '') throw new Error('Anthropic response had no text')
  return text
}

async function completeOpenAi(fetchImpl: typeof fetch, apiKey: string, prompt: string): Promise<string> {
  const model = process.env.DSH_DESKTOP_SYNC_OPENAI_MODEL ?? 'gpt-4o'
  const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`OpenAI HTTP ${String(response.status)}: ${body.slice(0, 500)}`)
  const parsed: unknown = JSON.parse(body)
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) throw new Error('OpenAI response missing choices')
  const first = parsed.choices[0]
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== 'string') {
    throw new Error('OpenAI response missing message content')
  }
  return first.message.content
}

function configureGitIdentity(cwd: string): void {
  requireGit(cwd, ['config', 'user.name', 'github-actions[bot]'], 'cannot set git user.name')
  requireGit(cwd, ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], 'cannot set git user.email')
  requireGit(cwd, ['config', 'core.hooksPath', '/dev/null'], 'cannot disable git hooks')
}

function syncBranchName(upstreamTag: string): string {
  return `${SYNC_BRANCH_PREFIX}${upstreamTag}`
}

function commitMessage(upstreamTag: string, needsHumanReview: boolean): string {
  const subject = needsHumanReview
    ? `sync(desktop): review upstream ${upstreamTag}`
    : `sync(desktop): import upstream ${upstreamTag}`
  return `${subject}\n\nSynced from ${UPSTREAM_REPO_DEFAULT}@${upstreamTag}.\n\n${UPSTREAM_TAG_TRAILER}: ${upstreamTag}\n`
}

function pullRequestBody(input: {
  upstreamTag: string
  desktopTag: string
  remainingConflictPaths: string[]
  overlayRestored: string[]
  aiAttempted: boolean
}): string {
  const conflictList = input.remainingConflictPaths.length === 0
    ? '_None remaining in the tree. Review the overlay restore and AI edits before merging._'
    : input.remainingConflictPaths.map(path => `- \`${path}\``).join('\n')
  const ai = input.aiAttempted
    ? 'An API key was present, so the workflow asked the model to edit remaining conflicted files. Treat every AI edit as untrusted until you review it.'
    : '`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` were unset, so conflicted files were left for humans.'
  return [
    `This draft imports upstream \`${input.upstreamTag}\` into the desktop copy.`,
    '',
    'Do not merge until you have resolved every remaining conflict and checked desktop overlay files.',
    'This workflow will **not** push \`' + input.desktopTag + '\` from a conflicted or AI-resolved run.',
    '',
    'After you merge to the default branch, cut the unsigned desktop GitHub Release by pushing that tag:',
    '',
    '```sh',
    `git tag ${input.desktopTag}`,
    `git push origin ${input.desktopTag}`,
    '```',
    '',
    ai,
    '',
    '### Remaining conflict paths',
    '',
    conflictList,
    '',
    '### Overlay paths restored from this repository',
    '',
    input.overlayRestored.map(path => `- \`${path}\``).join('\n') || '_None of the overlay allowlist existed on HEAD._',
  ].join('\n')
}

function ensureRemote(cwd: string, name: string, url: string): void {
  const existing = spawnGit(cwd, ['remote', 'get-url', name])
  if (existing.status === 0) {
    requireGit(cwd, ['remote', 'set-url', name, url], `cannot set ${name} remote`)
    return
  }
  requireGit(cwd, ['remote', 'add', name, url], `cannot add ${name} remote`)
}

function originHasRef(cwd: string, ref: string): boolean {
  const result = spawnGit(cwd, ['ls-remote', '--exit-code', 'origin', ref])
  return result.status === 0
}

function githubRepository(): string {
  const repo = emptyToUndefined(process.env.GITHUB_REPOSITORY)
  if (repo === undefined) throw new Error('GITHUB_REPOSITORY is unset')
  return repo
}

function runGh(host: SyncHost, args: string[], context: string): string {
  if (host.gh === undefined) {
    const result = spawnSync('gh', args, { env: process.env, maxBuffer: MAX_GIT_OUTPUT, encoding: 'utf8' })
    if ((result.status ?? 1) !== 0) {
      throw new Error(`${context}: ${(result.stderr || result.stdout || `gh exited ${String(result.status)}`).trim()}`)
    }
    return result.stdout
  }
  const result = host.gh(args)
  if (result.status !== 0) throw new Error(`${context}: ${result.stderr.trim() || result.stdout.trim()}`)
  return result.stdout
}

/**
 * Report whether a `gh run list` payload already includes a Desktop release for `tag`.
 * @param stdout - JSON array from `gh run list`.
 * @param tag - Desktop tag such as `desktop-v0.1.5-rc.1`.
 * @returns True when any run's `headBranch` equals the tag.
 */
export function desktopReleaseRunMatchesTag(stdout: string, tag: string): boolean {
  const parsed: unknown = JSON.parse(stdout === '' ? '[]' : stdout)
  if (!Array.isArray(parsed)) throw new Error('gh run list did not return a JSON array')
  return parsed.some(run => isRecord(run) && run.headBranch === tag)
}

/**
 * Report whether this sync may dispatch `desktop-release.yml`.
 * @param outcome - Result of `decideSyncOutcome`.
 * @param matchingRunFound - True when a Desktop release run already targets the tag.
 * @returns True only for a published tag that has not started packaging.
 */
export function shouldDispatchDesktopRelease(outcome: SyncOutcome, matchingRunFound: boolean): boolean {
  return outcome === 'published' && !matchingRunFound
}

/** Polling knobs for `ensureDesktopReleaseWorkflow`. */
export interface DesktopReleaseDispatchTiming {
  attempts?: number
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Wait briefly for `desktop-release.yml` to start from the tag push, then dispatch it.
 *
 * GitHub does not start other workflows from a `GITHUB_TOKEN` tag push. A PAT
 * with workflow scope usually starts Desktop release immediately; dispatch is
 * the fallback when no matching run appears. Conflicted imports never call this.
 * @param host - GitHub CLI adapter.
 * @param repo - `owner/name` repository slug.
 * @param tag - Desktop tag that must already exist on origin.
 * @param timing - Poll count, delay, and optional sleep replacement.
 * @returns `observed` when a run already targets `tag`, otherwise `dispatched`.
 */
export async function ensureDesktopReleaseWorkflow(
  host: SyncHost,
  repo: string,
  tag: string,
  timing: DesktopReleaseDispatchTiming = {},
): Promise<'observed' | 'dispatched'> {
  const attempts = timing.attempts ?? 4
  const delayMs = timing.delayMs ?? 5_000
  const sleep = timing.sleep ?? (async (ms: number) => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms)
    })
  })
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(delayMs)
    const stdout = runGh(host, [
      'run', 'list',
      '--workflow', 'desktop-release.yml',
      '--repo', repo,
      '--json', 'headBranch,event,status',
      '--limit', '30',
    ], 'cannot list Desktop release runs')
    if (desktopReleaseRunMatchesTag(stdout, tag)) return 'observed'
  }
  runGh(host, [
    'workflow', 'run', 'desktop-release.yml',
    '--repo', repo,
    '--ref', tag,
  ], 'cannot dispatch Desktop release')
  return 'dispatched'
}

/**
 * Run one upstream import from CLI options.
 * @param args - argv after the script path.
 * @param host - Git/GitHub adapters.
 * @returns Outcome string written to stdout.
 */
export async function runUpstreamDesktopSync(args: string[], host: SyncHost = {}): Promise<SyncOutcome> {
  const options = parseCli(args)
  const log = host.log ?? defaultLog
  const cwd = options.cwd
  configureGitIdentity(cwd)
  const upstreamUrl = `https://github.com/${options.upstreamRepo}.git`
  ensureRemote(cwd, 'upstream', upstreamUrl)
  requireGit(cwd, ['fetch', 'upstream', '--tags', '--force'], 'cannot fetch upstream tags')
  requireGit(cwd, ['fetch', 'origin', '--tags', '--force'], 'cannot fetch origin tags')
  const upstreamTags = parseLsRemoteTags(requireGit(
    cwd,
    ['ls-remote', '--tags', 'upstream', 'refs/tags/dsh-v*'],
    'cannot list upstream dsh-v* tags',
  ))
  const upstreamTag = options.upstreamTag ?? selectNewestUpstreamTag(upstreamTags)
  if (upstreamTag === undefined) throw new Error('no upstream dsh-v* tags found')
  if (versionFromReleaseTag(upstreamTag) === undefined || !upstreamTag.startsWith(UPSTREAM_TAG_PREFIX)) {
    throw new Error(`not an upstream dsh-v* tag: ${upstreamTag}`)
  }
  const desktopTag = desktopTagForUpstream(upstreamTag)
  const imported = new Set(readImportedUpstreamTags(cwd, 'HEAD'))
  const desktopTagExists = originHasRef(cwd, `refs/tags/${desktopTag}`)
  const alreadyImported = imported.has(upstreamTag)
  if (desktopTagExists || alreadyImported) {
    log(`skip: ${desktopTagExists ? `${desktopTag} already exists` : `${upstreamTag} already imported`}`)
    return 'skipped'
  }
  requireGit(cwd, ['fetch', 'upstream', `+refs/tags/${upstreamTag}:refs/tags/${upstreamTag}`], `cannot fetch ${upstreamTag}`)
  const branch = syncBranchName(upstreamTag)
  requireGit(cwd, ['checkout', '-B', branch], `cannot create ${branch}`)
  const mergeBase = resolveSyntheticMergeBase(cwd, 'HEAD', upstreamTag)
  const applied = applyUpstreamMerge(cwd, mergeBase, upstreamTag)
  let remaining = applied.remainingConflictPaths
  let aiAttempted = false
  if (applied.needsHumanReview && remaining.length > 0) {
    const ai = await resolveConflictsWithAi(cwd, remaining, host)
    aiAttempted = ai.attempted
    remaining = ai.unresolved
  }
  const needsHumanReview = applied.needsHumanReview
  requireGit(cwd, ['add', '-A'], 'cannot stage import')
  requireGit(cwd, ['commit', '--no-verify', '-m', commitMessage(upstreamTag, needsHumanReview)], 'cannot commit import')
  if (options.dryRun) {
    log(`dry-run: would push ${branch} for ${upstreamTag}`)
    return needsHumanReview ? 'pull_request' : 'published'
  }
  requireGit(cwd, ['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${branch}`], `cannot push ${branch}`)
  let defaultBranchUpdated = false
  if (!needsHumanReview) {
    const pushDefault = spawnGit(cwd, ['push', 'origin', `HEAD:refs/heads/${options.defaultBranch}`])
    defaultBranchUpdated = pushDefault.status === 0
    if (!defaultBranchUpdated) {
      log(`could not fast-forward ${options.defaultBranch}: ${pushDefault.stderr.trim() || pushDefault.stdout.trim()}`)
    }
  }
  const outcome = decideSyncOutcome({
    desktopTagExists: false,
    alreadyImported: false,
    needsHumanReview,
    defaultBranchUpdated,
  })
  if (outcome === 'published') {
    requireGit(cwd, ['tag', '-a', desktopTag, '-m', `Desktop release for upstream ${upstreamTag}`], `cannot create ${desktopTag}`)
    requireGit(cwd, ['push', 'origin', `refs/tags/${desktopTag}`], `cannot push ${desktopTag}`)
    const started = await ensureDesktopReleaseWorkflow(host, githubRepository(), desktopTag)
    log(started === 'observed'
      ? `published ${desktopTag}; Desktop release already started`
      : `published ${desktopTag}; dispatched Desktop release`)
    return outcome
  }
  const body = pullRequestBody({
    upstreamTag,
    desktopTag,
    remainingConflictPaths: remaining,
    overlayRestored: applied.overlayRestored,
    aiAttempted,
  })
  const existing = runGh(host, [
    'pr', 'list',
    '--repo', githubRepository(),
    '--head', branch,
    '--state', 'open',
    '--json', 'number',
  ], 'cannot list existing sync pull requests').trim()
  const parsedExisting: unknown = existing === '' ? [] : JSON.parse(existing)
  const hasOpenPr = Array.isArray(parsedExisting) && parsedExisting.length > 0
  if (!hasOpenPr) {
    runGh(host, [
      'pr', 'create',
      '--repo', githubRepository(),
      '--draft',
      '--base', options.defaultBranch,
      '--head', branch,
      '--title', `sync(desktop): review upstream ${upstreamTag}`,
      '--body', body,
    ], 'cannot open sync pull request')
  }
  log(`opened pull request for ${upstreamTag}; not tagging ${desktopTag}`)
  return 'pull_request'
}

const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  try {
    const outcome = await runUpstreamDesktopSync(process.argv.slice(2))
    process.stdout.write(`${outcome}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`upstream-desktop-sync: ${message}\n`)
    process.exitCode = 1
  }
}
