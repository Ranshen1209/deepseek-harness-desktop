/** Browser evidence for the shipped setup page, including measured progress and reduced motion. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import sharp from 'sharp'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { DesktopSetupState } from '../src/ipc.ts'

const renderer = fileURLToPath(new URL('../renderer/', import.meta.url))
const output = process.env.DSH_DESKTOP_UI_ARTIFACTS
const files = new Set(['first-run.html', 'first-run.css', 'first-run.js', 'startup-particles.js', 'deepseek-mark.svg'])
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
    const page = await browser.newPage({ viewport: { width: 760, height: 540 } })
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
      Record<'title' | 'description' | 'interaction' | 'verifying' | 'installing' | 'starting' | 'ready', string>
    assert.equal(await page.locator('h1').textContent(), expected.title)
    assert.equal(await page.locator('#description').textContent(), expected.description)
    assert.equal(await page.locator('#interaction').textContent(), expected.interaction)
    assert.equal(await page.locator('#status').textContent(), expected.verifying)
    assert.equal(await page.locator('#progress').getAttribute('value'), null)
    await page.evaluate(() => { (globalThis as unknown as { emitSetup: (state: DesktopSetupState) => void }).emitSetup({ phase: 'installing', completedBytes: 65, totalBytes: 100 }) })
    assert.equal(await page.locator('#status').textContent(), expected.installing)
    assert.equal(await page.locator('#progress').getAttribute('value'), '65')
    await page.waitForFunction(() => document.body.classList.contains('assembled'))
    assert.equal(await page.locator('#logo').evaluate(element => getComputedStyle(element).opacity), '0', 'the animated whale must contain particles only')
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
    for (const viewport of [{ width: 760, height: 540 }, { width: 640, height: 460 }, { width: 480, height: 300 }]) {
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
  const createScene = async (): Promise<Page> => {
    const page = await browser!.newPage({ viewport: { width: 760, height: 540 } })
    await page.clock.install({ time: new Date('2026-09-12T00:00:00Z') })
    await page.clock.pauseAt(new Date('2026-09-12T00:00:00Z'))
    await page.addInitScript(({ locale }) => {
      let seed = 17
      Math.random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
      const scope = globalThis as unknown as { dshDesktop: unknown; emitSetup: (state: DesktopSetupState) => void }
      scope.dshDesktop = { locale: async () => locale, setup: { subscribe(listener: (state: DesktopSetupState) => void) {
        scope.emitSetup = listener
        listener({ phase: 'starting' })
        return () => {}
      } } }
    }, { locale: resolveDesktopLocale('zh-CN') })
    await page.goto(`http://127.0.0.1:${address.port}/first-run.html`)
    await page.clock.runFor(2400)
    return page
  }
  const pixels = async (page: Page): Promise<Buffer> => {
    const png = await page.locator('#particles').evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL())
    return sharp(Buffer.from(png.split(',')[1]!, 'base64')).ensureAlpha().raw().toBuffer()
  }
  // Both pages have identical time and random input, so only pointer input can change the scene.
  const control = await createScene()
  const interactive = await createScene()
  const baseline = await pixels(control)
  assert.deepEqual(await pixels(interactive), baseline, 'unperturbed scenes must match')
  await interactive.mouse.move(360, 155)
  await control.clock.runFor(600)
  await interactive.clock.runFor(600)
  const reference = await pixels(control)
  const moved = await pixels(interactive)
  let displaced = 0
  for (let y = 34; y < 300; y += 1) {
    for (let x = 0; x < 760; x += 1) {
      if (Math.hypot(x - 360, y - 155) < 45) continue
      const offset = (y * 760 + x) * 4
      if (Math.abs(reference[offset]! - moved[offset]!) + Math.abs(reference[offset + 1]! - moved[offset + 1]!) > 70) displaced += 1
    }
  }
  assert(displaced > 500, `pointer must visibly displace particles beyond its glow, observed ${displaced} pixels`)
  assert.notDeepEqual(reference, baseline, 'particles must keep moving after assembly')
  await control.close()
  await interactive.close()

  const unclicked = await createScene()
  const clicked = await createScene()
  await unclicked.mouse.move(320, 390)
  await clicked.mouse.move(120, 390)
  await clicked.mouse.move(320, 390, { steps: 3 })
  for (const page of [unclicked, clicked]) await page.clock.runFor(240)
  assert.notDeepEqual(await pixels(clicked), await pixels(unclicked), 'movement between frames must leave a particle trail')
  for (const page of [unclicked, clicked]) await page.clock.runFor(1800)
  assert.deepEqual(await pixels(clicked), await pixels(unclicked), 'the particle trail must fully disperse')
  for (const page of [unclicked, clicked]) {
    await page.mouse.move(360, 155)
    await page.clock.runFor(1800)
  }
  assert.deepEqual(await pixels(clicked), await pixels(unclicked), 'click controls must start with identical canvases')
  await clicked.mouse.click(360, 155)
  for (const page of [unclicked, clicked]) await page.clock.runFor(320)
  assert.notDeepEqual(await pixels(clicked), await pixels(unclicked), 'click must change a scene with the same pointer position')
  if (output !== undefined) await clicked.screenshot({ path: join(output, 'startup-click.png') })
  for (const [index, page] of [unclicked, clicked].entries()) {
    if (index === 0) await page.evaluate(() => { (globalThis as unknown as { emitSetup: (state: DesktopSetupState) => void }).emitSetup({ phase: 'ready' }) })
    else await page.evaluate(() => { dispatchEvent(new Event('pagehide')) })
    const stopped = await pixels(page)
    await page.mouse.move(200, 100)
    await page.mouse.click(200, 100)
    await page.clock.runFor(1000)
    assert.deepEqual(await pixels(page), stopped, 'ready/pagehide must stop frames and pointer effects')
    await page.close()
  }
  console.log(`Desktop startup UI passed: both locales, actual progress, three sizes, reduced motion, persistent animation, mouse displacement (${displaced} pixels), particle trail dispersal, click burst and teardown.`)
} finally {
  await browser?.close()
  await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
}
