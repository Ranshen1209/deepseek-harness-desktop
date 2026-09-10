/** Verify the release tag, Desktop manifests, prepared seed, and installer filenames. */
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = file => JSON.parse(readFileSync(resolve(root, file), 'utf8'))
const version = manifest('package.json').version
assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
for (const app of ['cli', 'desktop', 'desktop-host']) {
  assert.equal(manifest(`apps/${app}/package.json`).version, version, `${app} version differs from dsh`)
}
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.ok(
    [`desktop-v${version}`, `desktop-windows-v${version}`, `desktop-macos-v${version}`].includes(process.env.GITHUB_REF_NAME),
    `Release tag must use the complete package version ${version}`,
  )
}

const target = process.argv[2]
if (target !== undefined) {
  assert.ok(['mac-arm64', 'win-x64'].includes(target), `Unsupported release target: ${target}`)
  const targetRoot = `apps/desktop/.desktop-build/targets/${target}`
  assert.equal(manifest(`${targetRoot}/seed/desktop-release.json`).version, version, 'Seed version differs from dsh')
  const extensions = target === 'mac-arm64' ? ['dmg', 'zip'] : ['exe']
  for (const extension of extensions) {
    const filename = `deepseek-harness-${version}-${target}.${extension}`
    const artifact = statSync(resolve(root, targetRoot, 'artifacts', filename))
    assert.ok(artifact.isFile() && artifact.size > 0, `Missing or empty installer: ${filename}`)
  }
}
if (process.env.GITHUB_OUTPUT !== undefined) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`)
}
process.stdout.write(`Desktop release version verified: ${version}\n`)
