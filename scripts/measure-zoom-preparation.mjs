import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveBuild } from './lib/serve-build.mjs'

const server = await serveBuild('dist')
const reports = []
try {
  for (const variant of (process.env.VARIANTS ?? 'svg-standard,svg-zoom-adaptive,svg-zoom-1').split(',')) {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
      const start = performance.now()
      await page.goto(`${server.url}?renderExperiment=${variant}`)
      await page.waitForFunction(() => window.__countriesQuizDebug && document.querySelector('.globe__hit-target'))
      const readyMs = performance.now() - start
      const preparationMs = await page.evaluate(() => window.__renderExperiment?.preparationMs ?? 0)
      await cdp.send('HeapProfiler.collectGarbage')
      const heap = await cdp.send('Runtime.getHeapUsage')
      reports.push({ variant, cpuRate: 6, readyMs, preparationMs, jsHeapBytes: heap.usedSize, embedderHeapBytes: heap.embedderHeapUsedSize, backingStorageBytes: heap.backingStorageSize })
    } finally { await browser.close() }
  }
  await writeFile(`output/playwright/${process.env.RESULT_NAME ?? 'zoom-preparation'}.json`, JSON.stringify(reports, null, 2) + '\n')
  console.table(reports)
} finally { server.close() }
