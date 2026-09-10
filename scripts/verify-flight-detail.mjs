import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { serveBuild } from './lib/serve-build.mjs'
const [baselineDir, currentDir = 'dist'] = process.argv.slice(2)
assert(baselineDir, 'Usage: node scripts/verify-flight-detail.mjs <full-detail-build> [current-build]')
const browser = await chromium.launch()
const captures = {}
try {
  for (const [name, directory] of [['before', baselineDir], ['after', currentDir]]) {
    const server = await serveBuild(directory)
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.clock.install({ time: new Date('2026-09-10T12:00:00Z') })
      await page.goto(server.url)
      await page.waitForFunction(() => window.__countriesQuizDebug && document.querySelector('.globe__hit-target'))
      await page.clock.pauseAt(new Date('2026-09-10T12:01:00Z'))
      await page.clock.fastForward(256)
      const capture = async state => {
        const result = await page.locator('.globe-frame').evaluate(el => ({
          mode: el.dataset.detailMode,
          land: el.querySelector('.globe__countries path').getAttribute('d'),
          coast: el.querySelector('.globe__coastlines').getAttribute('d'),
          borders: el.querySelector('.globe__borders').getAttribute('d'),
        }))
        assert.equal(result.mode, state === 'moving' && name === 'after' ? 'interactive' : 'full')
        captures[`${name}-${state}`] = result
      }
      const start = (from, to) => page.evaluate(([a, b]) => { void window.__countriesQuizDebug.benchmarkFlight(a, b) }, [from, to])
      await capture('initial')
      await start('GBR', 'USA')
      await page.clock.fastForward(2304)
      await start('USA', 'CHN')
      await page.clock.fastForward(512)
      await capture('moving')
      await page.clock.fastForward(2304)
      await capture('landed')
      await start('CHN', 'USA')
      await page.clock.fastForward(512)
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
      await page.clock.fastForward(256)
      assert.equal(await page.evaluate(() => window.__countriesQuizDebug.getFlightPerformance().status), 'cancelled')
      await capture('interrupted')
      await start('USA', 'CHN')
      await page.clock.fastForward(512)
      const box = await page.locator('.globe__map-svg').boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.clock.fastForward(256)
      assert.equal(await page.evaluate(() => window.__countriesQuizDebug.getFlightPerformance().status), 'cancelled')
      await capture('drag-interrupted')
      await page.mouse.up()
      assert.deepEqual(errors, [])
    } finally { await page.close(); server.close() }
  }
  for (const state of ['initial', 'landed', 'interrupted', 'drag-interrupted']) assert.deepEqual(captures[`after-${state}`], captures[`before-${state}`], `${state}: full geometry must remain unchanged`)
  assert.notEqual(captures['after-moving'].land, captures['before-moving'].land)
  console.log('PASS: simpler USA → China flight; exact full-detail geometry initially, on landing, and after zoom/drag interruption; no browser errors.')
} finally { await browser.close() }
