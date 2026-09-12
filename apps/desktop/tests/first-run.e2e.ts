/** Browser evidence for the shipped setup page, including measured progress and reduced motion. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { DesktopSetupState } from '../src/ipc.ts'

const renderer = fileURLToPath(new URL('../renderer/', import.meta.url))
const files = new Set(['first-run.html', 'first-run.css', 'first-run.js', 'deepseek-mark.svg'])
const types: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }
const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname.slice(1)
  if (!files.has(path)) { response.writeHead(404).end(); return }
  response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' })
  response.end(readFileSync(join(renderer, path)))
})
await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
const address = server.address()
assert(address !== null && typeof address !== 'string')
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  for (const language of ['en', 'zh-CN']) {
    const locale = resolveDesktopLocale(language)
    const page = await browser.newPage({ viewport: { width: 640, height: 460 } })
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(error.message) })
    await page.addInitScript(({ locale }) => {
      const scope = globalThis as unknown as {
        dshDesktop: unknown
        emitSetup: (state: DesktopSetupState) => void
        setupUnsubscribed: boolean
      }
      scope.dshDesktop = { locale: async () => locale, setup: { subscribe(listener: (state: DesktopSetupState) => void) {
        scope.emitSetup = listener
        listener({ phase: 'verifying' })
        return () => { scope.setupUnsubscribed = true }
      } } }
    }, { locale })
    await page.goto(`http://127.0.0.1:${address.port}/first-run.html`)
    await page.waitForFunction(() => document.querySelector('#status')?.textContent !== '')
    const expected = JSON.parse(readFileSync(new URL(`./expected/first-run-${language}.json`, import.meta.url), 'utf8')) as
      Record<'title' | 'verifying' | 'installing' | 'starting' | 'ready', string>
    assert.equal(await page.locator('h1').textContent(), expected.title)
    assert.equal(await page.locator('#status').textContent(), expected.verifying)
    assert.equal(await page.locator('#progress').getAttribute('value'), null)
    await page.evaluate(() => { (globalThis as unknown as { emitSetup: (state: DesktopSetupState) => void }).emitSetup({ phase: 'installing', completedBytes: 65, totalBytes: 100 }) })
    assert.equal(await page.locator('#status').textContent(), expected.installing)
    assert.equal(await page.locator('#progress').getAttribute('value'), '65')
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#logo') as Element).opacity === '1')
    const output = process.env.DSH_DESKTOP_UI_ARTIFACTS
    if (output !== undefined) {
      await mkdir(output, { recursive: true })
      await page.screenshot({ path: join(output, `first-run-${language}.png`) })
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert.equal(await page.locator('.logo-halo').evaluate(element => getComputedStyle(element).animationName), 'none')
    assert.equal(await page.evaluate(async () => {
      const canvas = document.querySelector('#particles') as HTMLCanvasElement
      await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
      const still = canvas.toDataURL()
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
        if (canvas.toDataURL() !== still) return false
      }
      return true
    }), true)
    for (const viewport of [{ width: 640, height: 460 }, { width: 480, height: 300 }]) {
      await page.setViewportSize(viewport)
      const size = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
      }))
      assert.deepEqual(size, viewport)
    }
    await page.evaluate(() => { (globalThis as unknown as { emitSetup: (state: DesktopSetupState) => void }).emitSetup({ phase: 'starting' }) })
    assert.equal(await page.locator('#status').textContent(), expected.starting)
    assert.equal(await page.locator('#progress').getAttribute('value'), null)
    await page.evaluate(() => { (globalThis as unknown as { emitSetup: (state: DesktopSetupState) => void }).emitSetup({ phase: 'ready' }) })
    assert.equal(await page.locator('#status').textContent(), expected.ready)
    assert.equal(await page.locator('#progress').getAttribute('value'), '100')
    assert.equal(await page.locator('body').evaluate(body => body.classList.contains('ready')), true)
    await page.evaluate(() => { dispatchEvent(new Event('pagehide')) })
    assert.equal(await page.evaluate(() => (globalThis as unknown as { setupUnsubscribed: boolean }).setupUnsubscribed), true)
    assert.deepEqual(errors, [])
    await page.close()
  }
  console.log('Desktop setup UI passed: English/Chinese, actual progress, 640×460/480×300, reduced motion, readiness and teardown.')
} finally {
  await browser?.close()
  await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
}
