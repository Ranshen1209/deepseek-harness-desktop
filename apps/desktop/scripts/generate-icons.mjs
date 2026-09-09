import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import png2icons from 'png2icons'
import sharp from 'sharp'

const APP_ROOT = resolve(import.meta.dirname, '..')
const SOURCE = join(APP_ROOT, 'build', 'icon.svg')
const OUTPUT = join(APP_ROOT, 'build')

async function renderSource() {
  return sharp(readFileSync(SOURCE), { density: 144 }).resize(1024, 1024).png().toBuffer()
}

async function renderWindowsSource(source) {
  const background = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" rx="220" fill="#fff"/></svg>',
  )
  return sharp(background).composite([{ input: source }]).png().toBuffer()
}

async function main() {
  mkdirSync(OUTPUT, { recursive: true })
  const source = await renderSource()
  const windowsSource = await renderWindowsSource(source)
  const icns = png2icons.createICNS(source, png2icons.BICUBIC, 0)
  const ico = png2icons.createICO(windowsSource, png2icons.BICUBIC, 0, false, true)
  if (icns === null || ico === null) throw new Error('desktop icons: failed to encode ICNS or ICO')
  writeFileSync(join(OUTPUT, 'icon.png'), source)
  writeFileSync(join(OUTPUT, 'icon.icns'), icns)
  writeFileSync(join(OUTPUT, 'icon.ico'), ico)
}

await main()
