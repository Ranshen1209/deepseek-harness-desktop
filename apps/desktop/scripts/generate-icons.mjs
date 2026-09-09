import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import png2icons from 'png2icons'
import sharp from 'sharp'

const APP_ROOT = resolve(import.meta.dirname, '..')
const SOURCE = join(APP_ROOT, 'build', 'icon.svg')
const OUTPUT = join(APP_ROOT, 'build')
const WINDOWS_LOGO_SCALE = 29.5
const WINDOWS_LOGO_OFFSET = (1024 - 24 * WINDOWS_LOGO_SCALE) / 2

async function renderSource() {
  return sharp(readFileSync(SOURCE), { density: 144 }).resize(1024, 1024).png().toBuffer()
}

function createWindowsSvg() {
  const source = readFileSync(SOURCE, 'utf8')
  const logo = source.match(/<g transform="[^"]+">([\s\S]*?)<\/g>/)?.[1]
  if (logo === undefined) throw new Error('desktop icons: source SVG does not contain its logo group')
  const offset = WINDOWS_LOGO_OFFSET.toFixed(4)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="220" fill="#fff"/><g transform="translate(${offset} ${offset}) scale(${WINDOWS_LOGO_SCALE})">${logo}</g></svg>`
}

async function renderWindowsSource() {
  return sharp(Buffer.from(createWindowsSvg())).resize(1024, 1024).png().toBuffer()
}

async function main() {
  mkdirSync(OUTPUT, { recursive: true })
  const source = await renderSource()
  const windowsSource = await renderWindowsSource()
  const icns = png2icons.createICNS(source, png2icons.BICUBIC, 0)
  const ico = png2icons.createICO(windowsSource, png2icons.BICUBIC, 0, false, true)
  if (icns === null || ico === null) throw new Error('desktop icons: failed to encode ICNS or ICO')
  writeFileSync(join(OUTPUT, 'icon.png'), source)
  writeFileSync(join(OUTPUT, 'icon.icns'), icns)
  writeFileSync(join(OUTPUT, 'icon.ico'), ico)
}

await main()
