import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { chromium } from 'playwright'
import { serveBuild } from './lib/serve-build.mjs'

const server = await serveBuild(process.argv[2] ?? 'dist')
const browser = await chromium.launch()
const reference = new Map()
let comparisons = 0
try {
  const variants = (process.env.VARIANTS ?? ',svg-islands,svg-adaptive,canvas-100,canvas-50').split(',')
  assert.equal(variants[0], '', 'First variant must be the default reference')
  for (const variant of variants) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.clock.install({ time: new Date('2026-09-10T12:00:00Z') })
    await page.goto(`${server.url}?renderExperiment=${variant}`)
    await page.waitForFunction(() => window.__countriesQuizDebug && document.querySelector('.globe__hit-target'))
    await page.clock.pauseAt(new Date('2026-09-10T12:01:00Z'))
    await page.clock.fastForward(256)
    const frame = page.locator('.globe-frame')
    const capture = async name => {
      assert.equal(await frame.getAttribute('data-detail-mode'), 'full', name)
      const data = await frame.evaluate(el => ({
        paths: [...el.querySelectorAll('.globe__countries path, .globe__coastlines, .globe__borders')].map(path => ({ d: path.getAttribute('d'), transform: path.getAttribute('transform') })),
        labels: el.querySelector('.globe__labels-svg').outerHTML,
        hidden: [...el.querySelector('.globe__map').children].some(child => child.style.visibility === 'hidden'),
        canvasVisible: [...el.querySelectorAll('canvas')].some(canvas => canvas.style.display !== 'none'),
      }))
      assert.equal(data.hidden, false)
      assert.equal(data.canvasVisible, false)
      if (!variant) reference.set(name, data)
      else {
        const expected = reference.get(name)
        if (!isDeepStrictEqual(data, expected)) {
          await mkdir('output/playwright/experiment-lifecycle', { recursive: true })
          await writeFile(`output/playwright/experiment-lifecycle/${variant}-${name}.json`, JSON.stringify({ data, expected }, null, 2))
          const a = JSON.stringify(data), b = JSON.stringify(expected)
          let index = 0
          while (a[index] === b[index] && index < a.length) index++
          throw new Error(`${variant}/${name}: first mismatch at ${index}: ${a.slice(index, index + 150)} / ${b.slice(index, index + 150)}`)
        }
        comparisons++
      }
    }
    const start = () => page.evaluate(() => { void window.__countriesQuizDebug.benchmarkFlight('USA', 'CHN') })
    await capture('initial')
    await start(); await page.clock.fastForward(512)
    if (variant.startsWith('canvas')) {
      assert.equal(await frame.getAttribute('data-experiment-backend'), 'canvas')
      assert.equal(await frame.locator('canvas').evaluate(el => el.style.display), 'block')
    }
    await page.clock.fastForward(2304); await capture('landed')
    await start(); await page.clock.fastForward(512)
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await page.clock.fastForward(256)
    assert.equal(await page.evaluate(() => window.__countriesQuizDebug.getFlightPerformance().status), 'cancelled')
    await capture('zoom-cancelled')
    await start(); await page.clock.fastForward(512)
    const box = await page.locator('.globe__map-svg').boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down(); await page.clock.fastForward(256)
    assert.equal(await page.evaluate(() => window.__countriesQuizDebug.getFlightPerformance().status), 'cancelled')
    await capture('pointer-cancelled')
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 30)
    await page.mouse.up(); await page.clock.fastForward(256)
    await capture('dragged')
    await start(); await page.clock.fastForward(512)
    await page.locator('#settings-button').click()
    await page.locator('#setting-projection').selectOption('mercator')
    await page.locator('#settings-close').click()
    await page.clock.fastForward(256)
    await capture('projection-changed')
    await start(); await page.clock.fastForward(512)
    if (variant) assert.equal(await frame.getAttribute('data-experiment-backend'), 'svg', 'flat projections use SVG')
    await page.clock.fastForward(2304); await capture('flat-landed')
    await page.setViewportSize({ width: 1100, height: 900 })
    // ResizeObserver runs on the browser's layout cycle, outside Playwright's
    // fake clock. Wait for delivery before advancing the scheduled render RAF.
    await page.evaluate(() => new Promise(resolve => {
      const observer = new ResizeObserver(() => { observer.disconnect(); resolve() })
      observer.observe(document.querySelector('.globe-frame'))
    }))
    await page.clock.fastForward(256)
    await capture('resized')
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`${variant || 'default'}: landing, zoom, pointer cancellation, drag, projection and resize verified`)
  }
  // Use real timing separately: a fake clock cannot measure rendering CPU cost.
  const adaptiveVariant = process.env.ADAPTIVE_VARIANT ?? 'svg-adaptive'
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  await page.goto(`${server.url}?renderExperiment=${adaptiveVariant}`)
  await page.waitForFunction(() => window.__countriesQuizDebug && document.querySelector('.globe__hit-target'))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
  const flight = await page.evaluate(() => window.__countriesQuizDebug.benchmarkFlight('GBR', 'CHN'))
  const probe = await page.evaluate(() => window.__renderExperiment)
  assert.equal(flight.status, 'complete')
  assert.equal(probe.startDetail, 'standard')
  assert(probe.transitions.some(({ from, to }) => from === 'standard' && to === 'coarse'), 'slow first flight must adapt')
  assert(probe.frames.some(frame => frame.detail === 'standard') && probe.frames.some(frame => frame.detail === (adaptiveVariant.includes('zoom') ? 'zoom' : 'coarse')))
  if (adaptiveVariant.includes('zoom')) assert(probe.frames.every(frame => frame.maxErrorPx <= 1), 'FPS adaptation must not breach the zoom quality floor')
  assert.equal(await page.locator('.globe-frame').getAttribute('data-experiment-detail'), 'full')
  await mkdir('output/playwright', { recursive: true })
  await writeFile(`output/playwright/${process.env.RESULT_NAME ?? 'experiment-lifecycle'}.json`, JSON.stringify({ comparisons, coldFlight: { ...flight, probe } }, null, 2))
  console.log(`PASS: ${comparisons} exact settled SVG comparisons; cold flight adapts after frame ${probe.transitions[0].frame}`)
} finally { await browser.close(); server.close() }
