/**
 * Create or reuse a GitHub Release for a `desktop-v*` / `desktop-windows-v*`
 * tag and upload only electron-builder installer files.
 *
 * A previous release job created the GitHub Release, then `find … | xargs`
 * uploaded nested helper binaries such as `fastlist-*.exe` and failed with
 * HTTP 422. A rerun then failed because `gh release create` refuses an
 * existing tag. This script selects `deepseek-harness-*.{dmg,zip,exe}`,
 * reuses an existing Release, and uploads with `--clobber`.
 */

import { spawnSync } from 'node:child_process'
import { lstatSync, readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const UTF8_MAX = 16 * 1024 * 1024
const INSTALLER_NAME = /^deepseek-harness-.+\.(dmg|zip|exe)$/u

/** Installer filename extensions that GitHub Release jobs may upload. */
export type DesktopInstallerKind = 'dmg' | 'zip' | 'exe'

/** Whether a combined macOS+Windows job or a Windows-only job is publishing. */
export type DesktopReleaseRequire = 'mac-win' | 'win'

/** CLI options after `parseArgs`. */
export interface UploadDesktopReleaseOptions {
  tag: string
  repo: string
  artifactsRoot: string
  require: DesktopReleaseRequire
  prerelease: boolean
  dryRun: boolean
}

/** Optional GitHub CLI adapter so tests do not talk to the network. */
export interface UploadDesktopReleaseHost {
  gh?: (args: string[]) => { status: number; stdout: string; stderr: string }
  log?: (message: string) => void
}

const invokedPath = process.argv[1]

/**
 * Report whether a relative artifact path is an installer this job may upload.
 * @param relativePath - Path from the downloaded-artifact root, using `/` or `\`.
 * @param kinds - Filename extensions this job is allowed to upload.
 * @returns True for a `deepseek-harness-*` installer that is not an unpacked helper.
 */
export function isDesktopGithubReleaseAsset(relativePath: string, kinds: readonly DesktopInstallerKind[]): boolean {
  const posix = relativePath.replaceAll('\\', '/')
  const segments = posix.split('/').filter(segment => segment !== '')
  if (segments.some(segment => segment.includes('unpacked') || segment.startsWith('fastlist'))) return false
  const name = segments.at(-1)
  if (name === undefined) return false
  const match = INSTALLER_NAME.exec(name)
  if (match === null) return false
  const kind = match[1]
  return kind !== undefined && kinds.includes(kind as DesktopInstallerKind)
}

/**
 * List installer files under a downloaded-artifact tree.
 * @param root - Directory that contains GitHub Actions artifact folders.
 * @param kinds - Filename extensions this job is allowed to upload.
 * @returns Absolute paths, sorted.
 */
export function collectDesktopReleaseAssets(root: string, kinds: readonly DesktopInstallerKind[]): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    const relative = Array.isArray(entry) ? entry.join('/') : entry
    const abs = resolve(root, relative)
    if (!lstatSync(abs).isFile()) continue
    if (isDesktopGithubReleaseAsset(relative, kinds)) files.push(abs)
  }
  files.sort()
  return files
}

/**
 * Return the installer kinds a job is allowed to upload.
 * @param require - Combined macOS+Windows publish, or Windows-only.
 * @returns Filename extensions that job may attach.
 */
export function installerKindsForRequire(require: DesktopReleaseRequire): DesktopInstallerKind[] {
  if (require === 'win') return ['exe']
  return ['dmg', 'zip', 'exe']
}

/**
 * Name missing installer classes for a publish job.
 * @param paths - Absolute installer paths already selected.
 * @param require - Combined macOS+Windows publish, or Windows-only.
 * @returns Human-readable missing classes; empty when the set is complete.
 */
export function missingDesktopReleaseAssetKinds(paths: string[], require: DesktopReleaseRequire): string[] {
  const names = paths.map(path => basename(path))
  const hasExe = names.some(name => name.endsWith('.exe'))
  const hasMac = names.some(name => name.endsWith('.dmg') || name.endsWith('.zip'))
  if (require === 'win') return hasExe ? [] : ['exe']
  const missing: string[] = []
  if (!hasMac) missing.push('dmg or zip')
  if (!hasExe) missing.push('exe')
  return missing
}

/**
 * Classify `gh release view` so a rerun can reuse an existing Release.
 * @param status - Process exit status.
 * @param combined - stdout plus stderr.
 * @returns `exists` when the tag already has a Release, `missing` when GitHub has none, otherwise `error`.
 */
export function classifyReleaseViewStatus(status: number, combined: string): 'exists' | 'missing' | 'error' {
  if (status === 0) return 'exists'
  if (/release not found/iu.test(combined) || /HTTP 404\b/u.test(combined)) return 'missing'
  return 'error'
}

/**
 * Report whether `gh release create` failed only because the tag already has a Release.
 * @param combined - stdout plus stderr.
 * @returns True when a retry should upload into the existing Release.
 */
export function releaseCreateFailedBecauseExists(combined: string): boolean {
  if (/ReleaseAsset\.name already exists/u.test(combined)) return false
  return /already_exists/u.test(combined)
    || /tag_name already exists/iu.test(combined)
    || /release .* already exists/iu.test(combined)
}

function defaultLog(message: string): void {
  process.stdout.write(`${message}\n`)
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return value.trim()
}

function parseRequire(value: string | undefined): DesktopReleaseRequire {
  if (value === 'win' || value === 'mac-win') return value
  throw new Error(`unknown --require value ${value ?? '(missing)'}; expected mac-win or win`)
}

function parseCli(args: string[]): UploadDesktopReleaseOptions {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      tag: { type: 'string' },
      repo: { type: 'string' },
      artifacts: { type: 'string' },
      require: { type: 'string' },
      prerelease: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  })
  const tag = emptyToUndefined(values.tag) ?? emptyToUndefined(process.env.GITHUB_REF_NAME)
  const repo = emptyToUndefined(values.repo) ?? emptyToUndefined(process.env.GITHUB_REPOSITORY)
  if (tag === undefined) throw new Error('release tag is unset (pass --tag or GITHUB_REF_NAME)')
  if (repo === undefined) throw new Error('GITHUB_REPOSITORY is unset (pass --repo)')
  return {
    tag,
    repo,
    artifactsRoot: resolve(values.artifacts ?? process.env.DSH_DESKTOP_RELEASE_ARTIFACTS ?? 'release-artifacts'),
    require: parseRequire(values.require ?? process.env.DSH_DESKTOP_RELEASE_REQUIRE),
    prerelease: values.prerelease === true || process.env.DSH_DESKTOP_RELEASE_PRERELEASE === '1',
    dryRun: values['dry-run'] === true,
  }
}

function runGh(host: UploadDesktopReleaseHost, args: string[]): { status: number; stdout: string; stderr: string } {
  if (host.gh !== undefined) return host.gh(args)
  const result = spawnSync('gh', args, { env: process.env, maxBuffer: UTF8_MAX, encoding: 'utf8' })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function requireGh(host: UploadDesktopReleaseHost, args: string[], context: string): string {
  const result = runGh(host, args)
  if (result.status !== 0) {
    throw new Error(`${context}: ${(result.stderr || result.stdout || `gh exited ${String(result.status)}`).trim()}`)
  }
  return result.stdout
}

/**
 * Create or reuse the GitHub Release for `options.tag` and upload selected installers.
 * @param args - argv after the script path.
 * @param host - GitHub CLI adapter.
 * @returns Absolute paths that were (or would be) uploaded.
 */
export function runUploadDesktopGithubRelease(args: string[], host: UploadDesktopReleaseHost = {}): string[] {
  const options = parseCli(args)
  const log = host.log ?? defaultLog
  const kinds = installerKindsForRequire(options.require)
  const assets = collectDesktopReleaseAssets(options.artifactsRoot, kinds)
  const missing = missingDesktopReleaseAssetKinds(assets, options.require)
  if (missing.length > 0) {
    throw new Error(`desktop GitHub Release: missing installer files (${missing.join(', ')}) under ${options.artifactsRoot}`)
  }
  if (options.dryRun) {
    log(`dry-run: would publish ${options.tag} with ${String(assets.length)} installer(s)`)
    return assets
  }
  const view = runGh(host, ['release', 'view', options.tag, '--repo', options.repo])
  const viewStatus = classifyReleaseViewStatus(view.status, `${view.stdout}\n${view.stderr}`)
  if (viewStatus === 'error') {
    throw new Error(`cannot inspect GitHub Release ${options.tag}: ${(view.stderr || view.stdout).trim()}`)
  }
  if (viewStatus === 'missing') {
    const createArgs = [
      'release', 'create', options.tag,
      '--repo', options.repo,
      '--title', options.tag,
      '--generate-notes',
    ]
    if (options.prerelease) createArgs.push('--prerelease')
    const created = runGh(host, createArgs)
    if (created.status !== 0 && !releaseCreateFailedBecauseExists(`${created.stdout}\n${created.stderr}`)) {
      throw new Error(`cannot create GitHub Release ${options.tag}: ${(created.stderr || created.stdout).trim()}`)
    }
    if (created.status === 0) log(`created GitHub Release ${options.tag}`)
    else log(`GitHub Release ${options.tag} already exists; uploading installers`)
  } else {
    log(`GitHub Release ${options.tag} already exists; uploading installers`)
  }
  requireGh(host, [
    'release', 'upload', options.tag,
    '--repo', options.repo,
    '--clobber',
    '--',
    ...assets,
  ], `cannot upload installers to ${options.tag}`)
  log(`uploaded ${String(assets.length)} installer(s) to ${options.tag}`)
  return assets
}

const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  try {
    runUploadDesktopGithubRelease(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`upload-desktop-github-release: ${message}\n`)
    process.exitCode = 1
  }
}
