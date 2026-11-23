// Bakes the bot faces' pictures (`src/ui/bots/face/bakedFaces.ts`) from the face shader into
// `public/bot-faces`, so the app shows faces without running the 3D renderer. Run it after changing
// the shader, the poses, the looks or the picture sizes:
//
//   npm i --no-save playwright-core   # once; the bake's only extra dependency
//   node scripts/bake-bot-faces.mjs
//
// It draws in headless Chromium on the GPU (Vulkan), never the software renderer. Set CHROME to a
// Chromium binary when Playwright's is not at its default place; QUALITY (0 to 1, default 0.86) sets
// the WebP colour quality (the alpha is lossless); ONLY bakes the files whose names contain it.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'public', 'bot-faces')
const quality = Number(process.env.QUALITY ?? 0.86)
const only = process.env.ONLY

const { chromium } = await import('playwright-core').catch(() => {
  throw new Error('The bake needs playwright-core: npm i --no-save playwright-core')
})

const bundle = await build({
  entryPoints: [join(root, 'scripts', 'bake-bot-faces', 'entry.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2022'
})

const browser = await chromium.launch({
  ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
  args: ['--use-angle=vulkan', '--ignore-gpu-blocklist']
})
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setContent('<!doctype html><html><body></body></html>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  if (errors.length) throw new Error('The bake page failed: ' + errors.join('; '))
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown'
  })
  if (/swiftshader|llvmpipe|software/i.test(renderer)) throw new Error(`The bake browser draws in software (${renderer}); it needs the GPU`)
  console.log('renderer:', renderer)

  const faces = (await page.evaluate(() => window.bake.faces())).filter(({ file }) => !only || file.includes(only))
  if (!only) rmSync(out, { recursive: true, force: true })
  let bytes = 0
  const started = Date.now()
  for (const [i, { file, face }] of faces.entries()) {
    const url = await page.evaluate(({ face, quality }) => window.bake.draw(face, quality), { face, quality })
    if (!url.startsWith('data:image/webp;')) throw new Error(`The browser did not encode WebP for ${file}`)
    const data = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
    mkdirSync(dirname(join(out, file)), { recursive: true })
    writeFileSync(join(out, file), data)
    bytes += data.length
    if ((i + 1) % 50 === 0) console.log(`${i + 1}/${faces.length}`)
  }
  const total = readdirSync(out, { recursive: true }).filter((f) => f.endsWith('.webp'))
  const size = total.reduce((sum, f) => sum + statSync(join(out, f)).size, 0)
  console.log(`baked ${faces.length} pictures (${(bytes / 1024).toFixed(0)} KB) in ${((Date.now() - started) / 1000).toFixed(1)} s; ${total.length} in all, ${(size / 1024).toFixed(0)} KB`)
} finally {
  await browser.close()
}
