/** Browser evidence for the shipped setup page, including error recovery, pointer input and reduced motion. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import sharp from 'sharp'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { DesktopBackendState } from '../src/backend-controller.ts'

const renderer = fileURLToPath(new URL('../renderer/', import.meta.url))
const output = process.env.DSH_DESKTOP_UI_ARTIFACTS
const files = new Set(['startup.html', 'startup.css', 'startup.js', 'startup-particles.js', 'deepseek-mark.svg'])
const types: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }
async function loadScene(page: Page) {
  // Serve the shipped files through the browser transport; no local TCP socket is needed.
  await page.route('http://desktop.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice(1)
    if (!files.has(path)) { await route.fulfill({ status: 404 }); return }
    await route.fulfill({ contentType: types[extname(path)] ?? 'application/octet-stream', body: readFileSync(join(renderer, path)) })
  })
  await page.goto('http://desktop.test/startup.html')
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  for (const language of ['en', 'zh-CN']) {
    const locale = resolveDesktopLocale(language)
    const page = await browser.newPage({ viewport: { width: 760, height: 540 } })
    page.setDefaultTimeout(15000)
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(error.message) })
    await page.addInitScript(({ locale }) => {
      const scope = globalThis as unknown as {
        dshDesktop: unknown
        emitBackend: (state: DesktopBackendState) => void
        backendUnsubscribed: boolean
      }
      scope.dshDesktop = { locale: async () => locale, backend: { status: async () => ({ phase: 'starting' }), subscribe(listener: (state: DesktopBackendState) => void) {
        scope.emitBackend = listener
        listener({ phase: 'starting' })
        return () => { scope.backendUnsubscribed = true }
      } } }
    }, { locale })
    await loadScene(page)
    await page.waitForFunction(() => document.querySelector('#title')?.textContent !== '')
    assert.equal(await page.locator('h1').textContent(), locale.messages.startupLoading)
    assert.equal(await page.locator('#description').textContent(), locale.messages.startupLoadingDescription)
    await page.waitForFunction(() => document.body.classList.contains('assembled'))
    assert.equal(await page.locator('#logo').evaluate(element => getComputedStyle(element).opacity), '0', 'the animated whale must contain particles only')
    if (output !== undefined) {
      await mkdir(output, { recursive: true })
      await page.screenshot({ path: join(output, `startup-${language}.png`) })
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert.equal(await page.locator('#spinner').evaluate(element => getComputedStyle(element).animationName), 'none')
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
    await page.evaluate(() => { (globalThis as unknown as { emitBackend: (state: DesktopBackendState) => void }).emitBackend({ phase: 'ready' }) })
    assert.equal(await page.locator('main').getAttribute('aria-busy'), 'false')
    await page.evaluate(() => { dispatchEvent(new Event('pagehide')) })
    assert.equal(await page.evaluate(() => (globalThis as unknown as { backendUnsubscribed: boolean }).backendUnsubscribed), true)
    assert.deepEqual(errors, [])
    await page.close()
  }
  const advance = (page: Page, milliseconds: number) => page.evaluate(
    ms => (globalThis as unknown as { advanceScene: (ms: number) => void }).advanceScene(ms), milliseconds,
  )
  const createScene = async (): Promise<Page> => {
    const page = await browser!.newPage({ viewport: { width: 760, height: 540 } })
    page.setDefaultTimeout(15000)
    await page.addInitScript(({ locale }) => {
      let timestamp = 0, sequence = 0
      const frames = new Map<number, FrameRequestCallback>()
      window.requestAnimationFrame = (callback) => { frames.set(++sequence, callback); return sequence }
      window.cancelAnimationFrame = (id) => { frames.delete(id) }
      Object.defineProperty(performance, 'now', { value: () => timestamp })
      Object.assign(globalThis, { advanceScene(milliseconds: number) {
        for (let i = 0; i < Math.round(milliseconds / (1000 / 60)); i++) {
          timestamp += 1000 / 60
          const pending = [...frames.values()]; frames.clear()
          for (const callback of pending) callback(timestamp)
        }
      } })
      let seed = 17
      Math.random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
      const scope = globalThis as unknown as { dshDesktop: unknown; emitBackend: (state: DesktopBackendState) => void }
      scope.dshDesktop = { locale: async () => locale, backend: { status: async () => ({ phase: 'starting' }), subscribe(listener: (state: DesktopBackendState) => void) {
        scope.emitBackend = listener
        listener({ phase: 'starting' })
        return () => {}
      } } }
    }, { locale: resolveDesktopLocale('zh-CN') })
    await loadScene(page)
    await advance(page, 2400)
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
  await advance(control, 600)
  await advance(interactive, 600)
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
  for (const page of [unclicked, clicked]) await advance(page, 240)
  assert.notDeepEqual(await pixels(clicked), await pixels(unclicked), 'movement between frames must leave a particle trail')
  for (const page of [unclicked, clicked]) await advance(page, 1800)
  assert.deepEqual(await pixels(clicked), await pixels(unclicked), 'the particle trail must fully disperse')
  for (const page of [unclicked, clicked]) {
    await page.mouse.move(360, 155)
    await advance(page, 1800)
  }
  assert.deepEqual(await pixels(clicked), await pixels(unclicked), 'click controls must start with identical canvases')
  await clicked.mouse.click(360, 155)
  for (const page of [unclicked, clicked]) await advance(page, 320)
  assert.notDeepEqual(await pixels(clicked), await pixels(unclicked), 'click must change a scene with the same pointer position')
  if (output !== undefined) await clicked.screenshot({ path: join(output, 'startup-click.png') })
  for (const [index, page] of [unclicked, clicked].entries()) {
    if (index === 0) await page.evaluate(() => { (globalThis as unknown as { emitBackend: (state: DesktopBackendState) => void }).emitBackend({ phase: 'ready' }) })
    else await page.evaluate(() => { dispatchEvent(new Event('pagehide')) })
    const stopped = await pixels(page)
    await page.mouse.move(200, 100)
    await page.mouse.click(200, 100)
    await advance(page, 1000)
    assert.deepEqual(await pixels(page), stopped, 'ready/pagehide must stop frames and pointer effects')
    await page.close()
  }
  console.log(`Desktop startup UI passed: both locales, backend availability, three sizes, reduced motion, persistent animation, mouse displacement (${displaced} pixels), particle trail dispersal, click burst and teardown.`)
} finally {
  await browser?.close()
}
