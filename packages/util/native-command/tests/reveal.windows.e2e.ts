/** Interactive Windows smoke: verify Explorer visibility and selection through the real opener. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'

assert.equal(process.platform, 'win32', 'This smoke requires an interactive Windows desktop')
const { revealNativePath } = await import(process.argv[2] ?? '../src/index.ts') as typeof import('../src/index.ts')
const run = promisify(execFile)
// Explorer expands Windows short names such as the inherited TEMP directory's 8.3 username.
const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-reveal-')))
const evidence = process.argv[3]
const results: { name: string; selected: boolean; visible: boolean }[] = []

interface ExplorerWindow {
  folder: string
  selected: string[]
  visible: boolean
}

async function windows(close: boolean): Promise<ExplorerWindow[]> {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$root = '${root.replace(/'/g, "''")}\\'
$shell = New-Object -ComObject Shell.Application
$result = @()
foreach ($window in @($shell.Windows())) {
  try {
    $folder = $window.Document.Folder.Self.Path
    if ($folder.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
      $selected = @($window.Document.SelectedItems() | ForEach-Object { $_.Path })
      $result += @{ folder = $folder; selected = $selected; visible = $window.Visible }
      ${close ? '$window.Quit()' : ''}
    }
  } catch {
    # A Shell window can disappear or be between navigation documents during enumeration.
  }
}
ConvertTo-Json -InputObject @($result) -Compress -Depth 5
`
  const { stdout } = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  return JSON.parse(stdout) as ExplorerWindow[]
}

async function waitForSelection(path: string): Promise<ExplorerWindow> {
  const deadline = Date.now() + 15_000
  do {
    const selected = (await windows(false)).find(window => window.visible
      && window.selected.some(item => item.toLowerCase() === path.toLowerCase()))
    if (selected !== undefined) return selected
    await setTimeout(100)
  } while (Date.now() < deadline)
  throw new Error(`Explorer did not visibly select ${path}`)
}

try {
  const cases = [
    { name: 'plain', file: 'report.txt' },
    { name: 'unicode and commas', file: '中文 报告,#%.txt' },
    { name: 'literal metacharacters', file: "o'reilly,$(test).txt" },
    { name: 'forward slashes', file: '报告.txt' },
  ]
  for (const test of cases) {
    const directory = join(root, test.name)
    await mkdir(directory)
    const path = join(directory, test.file)
    await writeFile(path, 'Native Explorer regression fixture\n')
    await revealNativePath(test.name === 'forward slashes' ? path.replace(/\\/g, '/') : path,
      AbortSignal.timeout(20_000))
    const selected = await waitForSelection(path)
    results.push({ name: test.name, selected: true, visible: selected.visible })
    console.log(JSON.stringify(results.at(-1)))
  }
} finally {
  try {
    const deadline = Date.now() + 10_000
    while ((await windows(false)).length !== 0) {
      assert.ok(Date.now() < deadline, 'Test Explorer windows did not close')
      await windows(true)
      await setTimeout(100)
    }
  } finally {
    if (evidence !== undefined) {
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, 'explorer-selection.json'), JSON.stringify(results, null, 2) + '\n')
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
