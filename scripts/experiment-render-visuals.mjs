import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { serveBuild } from './lib/serve-build.mjs'

const directory = process.argv[2] ?? 'dist'
const variants = (process.env.VARIANTS ?? 'svg-standard,svg-coarse,svg-islands,svg-full,canvas-100,canvas-75,canvas-50').split(',')
const output = process.env.VISUAL_OUTPUT ?? 'output/playwright/render-experiments-visual'
await mkdir(output, { recursive: true })
const flagsDirectory = 'output/playwright/flag-assets'
try { await readFile(`${flagsDirectory}/package/3x2/GB.svg`) }
catch {
  await mkdir(flagsDirectory, { recursive: true })
  const exec = promisify(execFile)
  await exec('npm', ['pack', 'country-flag-icons@1.5.19', '--pack-destination', flagsDirectory, '--silent'])
  await exec('tar', ['-xzf', `${flagsDirectory}/country-flag-icons-1.5.19.tgz`, '-C', flagsDirectory])
}
const server = await serveBuild(directory)
const browser = await chromium.launch()
const labels = new Map()
const reports = []
try {
  for (const variant of variants) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('https://cdn.jsdelivr.net/npm/country-flag-icons@1.5.19/3x2/*.svg', async route => {
      const filename = new URL(route.request().url()).pathname.split('/').at(-1)
      await route.fulfill({ contentType: 'image/svg+xml', body: await readFile(`output/playwright/flag-assets/package/3x2/${filename}`) })
    })
    await page.clock.install({ time: new Date('2026-09-10T12:00:00Z') })
    await page.goto(`${server.url}?flags=1&capitals=1&renderExperiment=${variant}`)
    await page.waitForFunction(() => window.__countriesQuizDebug && document.querySelector('.globe__hit-target'))
    await page.clock.pauseAt(new Date('2026-09-10T12:01:00Z'))
    for (const country of ['United States', 'China', 'France', 'Barbados']) {
      await page.getByRole('searchbox').fill(country)
      await page.clock.fastForward(2304)
    }
    const flight = (from, to) => page.evaluate(([a, b]) => { void window.__countriesQuizDebug.benchmarkFlight(a, b) }, [from, to])
    const capture = async name => {
      await page.waitForLoadState('networkidle')
      const detail = await page.locator('.globe-frame').evaluate((el, geometry) => ({
        detail: el.dataset.experimentDetail, backend: el.dataset.experimentBackend,
        lod: el.dataset.experimentLod, maxErrorPx: el.dataset.experimentError, scale: el.dataset.experimentScale,
        labels: el.querySelector('.globe__labels-svg').outerHTML,
        canvas: [...el.querySelectorAll('canvas')].map(canvas => ({ width: canvas.width, height: canvas.height, display: canvas.style.display })),
        ...(geometry ? { geometry: {
          width: el.querySelector('svg').viewBox.baseVal.width, height: el.querySelector('svg').viewBox.baseVal.height,
          coast: el.querySelector('.globe__coastlines').getAttribute('d'), borders: el.querySelector('.globe__borders').getAttribute('d'),
        } } : {}),
      }), Boolean(process.env.GEOMETRY))
      if (!labels.has(name)) labels.set(name, detail.labels)
      else if (process.env.LABEL_TOLERANCE) {
        const difference = await page.evaluate(([a, b, tolerance]) => {
          const parser = new DOMParser()
          const nodes = source => [...parser.parseFromString(source, 'image/svg+xml').querySelectorAll('*')]
          const x = nodes(a), y = nodes(b)
          if (x.length !== y.length) return 'Node count changed'
          const number = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi
          for (let i = 0; i < x.length; i++) {
            if (x[i].tagName !== y[i].tagName || x[i].textContent !== y[i].textContent || x[i].attributes.length !== y[i].attributes.length) return 'Label structure or text changed'
            for (const attribute of x[i].attributes) {
              const av = attribute.value, bv = y[i].getAttribute(attribute.name)
              if (av === bv) continue
              if (attribute.name !== 'transform' || !bv || av.replace(number, '#') !== bv.replace(number, '#')) return `Attribute ${attribute.name} changed`
              const an = av.match(number).map(Number), bn = bv.match(number).map(Number)
              if (an.some((n, j) => Math.abs(n - bn[j]) > tolerance)) return `Transform moved by more than ${tolerance}px`
            }
          }
          return null
        }, [detail.labels, labels.get(name), Number(process.env.LABEL_TOLERANCE)])
        assert.equal(difference, null, `${variant}/${name}: ${difference}`)
      } else assert.equal(detail.labels, labels.get(name), `${variant}/${name}: labels and plane must remain identical`)
      await page.locator('.globe-frame').screenshot({ path: `${output}/${variant}-${name}.png` })
      reports.push({ variant, name, ...detail, labels: undefined })
    }
    await flight('GBR', 'USA'); await page.clock.fastForward(2304)
    if (process.env.OVERVIEW) {
      for (let i = 0; i < 20; i++) {
        await page.locator('.globe__map-svg').dispatchEvent('wheel', { deltaY: 160, bubbles: true })
        await page.clock.fastForward(32)
      }
      assert.equal(await page.locator('.globe-frame').getAttribute('data-zoom'), '0.780')
      await flight('USA', 'CHN'); await page.clock.fastForward(128)
      await capture('overview')
      await page.clock.fastForward(2304)
      await flight('CHN', 'USA'); await page.clock.fastForward(2304)
    }
    await flight('USA', 'CHN'); await page.clock.fastForward(800)
    await capture('wide')
    await page.clock.fastForward(2304); await capture('landed')
    await flight('CHN', 'FRA'); await page.clock.fastForward(2304)
    await flight('FRA', 'GBR'); await page.clock.fastForward(1200)
    await capture('europe')
    await page.clock.fastForward(2304)
    await flight('GBR', 'BRB'); await page.clock.fastForward(1400)
    await capture('caribbean')
    await page.clock.fastForward(2304)
    assert.equal(await page.locator('.globe-frame').getAttribute('data-detail-mode'), 'full')
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`${variant}: snapshots, labels and plane verified`)
  }
  await writeFile(`${output}/results.json`, JSON.stringify(reports, null, 2))
  const scenes = [...new Set(reports.map(report => report.name))]
  const html = `<!doctype html><meta name="viewport" content="width=device-width"><title>Rendering experiments</title><style>body{background:#14212b;color:#eee;font:15px system-ui;margin:24px}h2{margin-top:32px}.row{display:flex;gap:20px;overflow:auto}figure{margin:0;flex:0 0 356px}img{width:356px;height:auto}figcaption{padding:8px 0}</style><h1>Rendering experiments — identical camera positions</h1><p>Images displayed at approximately their phone size. Labels, flags and plane are unchanged SVG overlays.</p>${scenes.map(name=>`<h2>${name}</h2><div class="row">${variants.map(variant=>`<figure><figcaption>${variant}</figcaption><img src="${variant}-${name}.png"></figure>`).join('')}</div>`).join('')}`
  await writeFile(`${output}/index.html`, html)
} finally { await browser.close(); server.close() }
