/** Portable, release-bound dependency images deployed without running pnpm on first launch. */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { create, extract, type ReadEntry } from 'tar'

/** Archive stored beside the release's offline maintenance seed. */
export const RUNTIME_IMAGE_ARCHIVE = 'runtime-image.tar'
/** Authenticated descriptor for the preinstalled dependency tree. */
export const RUNTIME_IMAGE_MANIFEST = 'runtime-image.json'

/** Actual archive bytes consumed during deployment, independent of backend readiness. */
export interface RuntimeImageProgress {
  readonly completedBytes: number
  readonly totalBytes: number
}

interface RuntimeImage {
  readonly schemaVersion: 1
  readonly version: string
  readonly platform: string
  readonly arch: string
  readonly entries: number
  readonly bytes: number
  readonly sha256: string
}

function modulePath(path: string): boolean {
  return path.startsWith('node_modules/') && !path.includes('\\') && !path.includes(':')
    && !path.split('/').some(part => part === '..' || part === '.' || part === '')
}

function imageManifest(seed: string, version: string): RuntimeImage {
  const value: unknown = JSON.parse(readFileSync(join(seed, RUNTIME_IMAGE_MANIFEST), 'utf8'))
  if (typeof value !== 'object' || value === null) throw new Error('desktop runtime image: invalid descriptor')
  const image = value as Record<string, unknown>
  if (image.schemaVersion !== 1 || image.version !== version
    || image.platform !== process.platform || image.arch !== process.arch
    || typeof image.entries !== 'number' || !Number.isSafeInteger(image.entries) || image.entries < 1
    || typeof image.bytes !== 'number' || !Number.isSafeInteger(image.bytes) || image.bytes < 1
    || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(image.sha256)) {
    throw new Error('desktop runtime image: descriptor does not match this release and platform')
  }
  return image as unknown as RuntimeImage
}

/**
 * Archive a verified hoisted installation, preserving only relative links to files inside it.
 * @param project - build-owned profile with its final node_modules installation; directory aliases are resolved before traversal.
 * @param version - release version bound to the dependency tree.
 * @param target - platform and architecture of the Node.js runtime that installed the tree.
 * @returns descriptor written next to the archive.
 */
export async function createRuntimeImage(
  project: string,
  version: string,
  target: { platform: string; arch: string },
): Promise<RuntimeImage> {
  const projectRoot = realpathSync(project)
  const root = realpathSync(join(projectRoot, 'node_modules'))
  const entries: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      const name = relative(projectRoot, path).split(sep).join('/')
      if (name === 'node_modules/.modules.yaml' || name === 'node_modules/.pnpm-workspace-state-v1.json') continue
      if (!modulePath(name)) throw new Error(`desktop runtime image: invalid path ${name}`)
      if (entry.isDirectory()) visit(path)
      else {
        if (entry.isSymbolicLink()) {
          const target = readlinkSync(path)
          const resolved = realpathSync(path)
          if (isAbsolute(target) || !resolved.startsWith(root + sep) || !lstatSync(resolved).isFile()) {
            throw new Error(`desktop runtime image: non-portable dependency link ${name}`)
          }
        } else if (!entry.isFile()) throw new Error(`desktop runtime image: unsupported file ${name}`)
        entries.push(name)
      }
    }
  }
  visit(root)
  const archive = join(projectRoot, RUNTIME_IMAGE_ARCHIVE)
  // The build-only synchronous writer avoids async pack stalls on pnpm's hardlinked files.
  create({ cwd: projectRoot, file: archive, portable: true, noMtime: true, sync: true }, entries)
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(archive)) {
    const body = chunk as Buffer
    hash.update(body)
    bytes += body.byteLength
  }
  const image: RuntimeImage = { schemaVersion: 1, version, platform: target.platform, arch: target.arch,
    entries: entries.length, bytes, sha256: hash.digest('hex') }
  writeFileSync(join(projectRoot, RUNTIME_IMAGE_MANIFEST), `${JSON.stringify(image, undefined, 2)}\n`)
  return image
}

/**
 * Hash and unpack an image in one pass; callers activate the isolated destination only after success.
 * @param seed - release seed whose descriptor was authenticated by the seed inventory.
 * @param destination - staging profile without node_modules; partial output remains owned by the caller on failure.
 * @param version - exact expected release version.
 * @param onProgress - receives actual consumed archive bytes.
 */
export async function extractRuntimeImage(
  seed: string,
  destination: string,
  version: string,
  onProgress?: (progress: RuntimeImageProgress) => void,
): Promise<void> {
  const image = imageManifest(seed, version)
  if (existsSync(join(destination, 'node_modules'))) throw new Error('desktop runtime image: destination is not empty')
  await mkdir(destination, { recursive: true })
  const hash = createHash('sha256')
  const paths = new Set<string>()
  const files = new Set<string>()
  const links = new Map<string, string>()
  let invalid: Error | undefined
  let bytes = 0
  let lastProgress = 0
  onProgress?.({ completedBytes: 0, totalBytes: image.bytes })
  const monitor = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength
      hash.update(chunk)
      if (bytes > image.bytes) { callback(new Error('desktop runtime image: archive exceeds declared size')); return }
      if (performance.now() - lastProgress > 100) {
        onProgress?.({ completedBytes: bytes, totalBytes: image.bytes })
        lastProgress = performance.now()
      }
      callback(null, chunk)
    },
  })
  const unpack = extract({
    cwd: destination, strict: true, noMtime: true, chmod: true, preservePaths: false,
    // tar serializes Windows writes; bounded stream chunks avoid a callback round trip for each filesystem operation.
    sync: process.platform === 'win32',
    filter: (path, raw) => {
      // tar shares filter's type with create(); extract() supplies ReadEntry.
      const entry = raw as ReadEntry
      if (invalid !== undefined) return false
      if (!modulePath(path) || paths.has(path)) {
        invalid = new Error(`desktop runtime image: invalid or duplicate path ${path}`)
        return false
      }
      let parent = posix.dirname(path)
      while (parent !== '.') {
        if (links.has(parent)) { invalid = new Error('desktop runtime image: entry traverses a link'); return false }
        parent = posix.dirname(parent)
      }
      paths.add(path)
      if (entry.type === 'File' || entry.type === 'OldFile') files.add(path)
      else if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
        if (typeof entry.linkpath !== 'string' || entry.linkpath === '') {
          invalid = new Error(`desktop runtime image: missing link target ${path}`)
          return false
        }
        const target = entry.type === 'Link' ? entry.linkpath : posix.join(posix.dirname(path), entry.linkpath)
        if (isAbsolute(entry.linkpath) || entry.linkpath.includes('\\') || !modulePath(target)) {
          invalid = new Error(`desktop runtime image: link escapes dependencies ${path}`)
          return false
        }
        links.set(path, target)
      } else {
        invalid = new Error(`desktop runtime image: unsupported entry type ${entry.type}`)
        return false
      }
      return true
    },
  })
  await pipeline(createReadStream(join(seed, RUNTIME_IMAGE_ARCHIVE)), monitor, unpack)
  if (invalid !== undefined) throw invalid
  if (bytes !== image.bytes || hash.digest('hex') !== image.sha256 || paths.size !== image.entries) {
    throw new Error('desktop runtime image: archive integrity verification failed')
  }
  for (const [path, target] of links) {
    if (!files.has(target)) throw new Error(`desktop runtime image: link does not target a regular file ${path}`)
  }
  for (const file of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-desktop-host/lib/index.js']) {
    if (!files.has(`node_modules/${file}`)) throw new Error(`desktop runtime image: missing runtime entry ${file}`)
  }
  onProgress?.({ completedBytes: bytes, totalBytes: image.bytes })
}
