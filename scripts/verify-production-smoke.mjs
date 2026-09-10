import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveBuild } from './lib/serve-build.mjs'

// Exercise normal play and the saved-game flow, locally or after deployment.
const server = process.env.BASE_URL ? null : await serveBuild(process.argv[2] ?? 'dist')
const url = process.env.BASE_URL ?? server.url
const browser = await chromium.launch()
const errors = [], failedAssets = []
const output = process.env.SMOKE_OUTPUT ?? 'output/playwright/production-smoke'
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.url().startsWith(url) && response.status() >= 400) failedAssets.push({ url: response.url(), status: response.status() })
  })
  await page.goto(url)
  const ready = () => page.waitForFunction(() => window.__countriesQuizDebug && document.querySelector('.globe__hit-target'))
  await ready()
  assert.equal(await page.evaluate(() => window.__renderExperiment), undefined, 'Normal play must not collect experiment telemetry')
  assert(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('zoom-lod-standard-'))), 'Default renderer did not load its zoom-dependent geometry')
  await page.getByRole('searchbox').fill('United States')
  await page.waitForFunction(() => document.querySelector('#score').textContent.startsWith('1/'))
  await page.waitForFunction(() => window.__countriesQuizDebug.getFlightPerformance()?.status === 'complete')
  await page.reload()
  await ready()
  await page.locator('#resume-modal').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Continue quiz', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#score').textContent.startsWith('1/'))
  await page.getByRole('searchbox').fill('China')
  await page.waitForFunction(() => document.querySelector('#score').textContent.startsWith('2/'))
  await page.waitForFunction(() => window.__countriesQuizDebug.getFlightPerformance()?.status === 'complete')
  assert.equal(await page.locator('.globe-frame').getAttribute('data-detail-mode'), 'full')
  await mkdir(output, { recursive: true })
  await page.locator('.globe-frame').screenshot({ path: `${output}/landed.png` })
  await page.reload()
  await ready()
  await page.locator('#resume-modal').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Start new', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#score').textContent.startsWith('0/'))
  assert.deepEqual(errors, [])
  assert.deepEqual(failedAssets, [])
  const result = { url, defaultLodLoaded: true, telemetryDisabled: true, acceptedAnswers: true, resumePassed: true, startNewPassed: true, fullDetailAfterLanding: true, errors, failedAssets }
  await writeFile(`${output}/results.json`, JSON.stringify(result, null, 2) + '\n')
  console.log(result)
} finally { await browser.close(); server?.close() }
