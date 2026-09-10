import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

// Sequential production-build comparisons. Hold the zoom at its minimum for
// the entire flight, rather than averaging an overview-to-closeup transition.
const group = process.env.GROUP ?? 'overview'
const variants = ['svg-standard', 'svg-zoom-standard-1', 'svg-planet']
const order = group === 'overview' ? [...variants, ...variants.toReversed()]
  : group === 'projection-only' ? ['svg-cartesian']
    : group === 'native' ? ['svg-standard', 'svg-planet'] : ['svg-zoom-standard-1', 'svg-planet']
const reports = []
for (const [i, variant] of order.entries()) {
  const name = `planet-${group}-${i}-${variant}`
  const hold = group !== 'normal'
  const query = `?renderExperiment=${variant}${hold ? '&experimentZoom=overview' : ''}`
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/benchmark-flights.mjs', 'dist', name, group === 'native' ? '1' : '6', '2', 'mobile'], {
      stdio: 'inherit', env: { ...process.env, QUERY: query, START_OVERVIEW: hold ? '1' : '', PROFILE: '', SOLVED_COUNT: group === 'solved' ? '100' : '0', ROUTES: 'GBR,USA,CHN,USA,AUS,GBR' },
    })
    child.on('error', reject); child.on('exit', resolve)
  })
  assert.equal(code, 0)
  const report = JSON.parse(await readFile(`output/playwright/${name}.json`))
  assert.deepEqual(report.errors, [])
  if (hold) {
    const scales = report.results.flatMap(result => result.experiment.frames.map(frame => frame.scale))
    assert(Math.max(...scales) - Math.min(...scales) < 1e-8, 'Benchmark zoom drifted')
    if (variant === 'svg-planet' || variant === 'svg-cartesian') assert(report.results.every(result => result.experiment.frames.every(frame => frame.cartesian)), 'Projection shortcut not exercised')
  }
  reports.push(report)
}
const summary = [...new Set(order)].map(variant => {
  const runs = reports.filter(report => report.query.includes(`renderExperiment=${variant}&`) || report.query === `?renderExperiment=${variant}`)
  const flights = runs.flatMap(run => run.results)
  const fps = flights => flights.reduce((sum, flight) => sum + flight.frameCount, 0) / flights.reduce((sum, flight) => sum + flight.frameCount * flight.averageFrameMs, 0) * 1000
  const frames = flights.flatMap(flight => flight.experiment.frames)
  return { variant, fps: fps(flights), runFps: runs.map(run => run.fps), usaChinaFps: fps(flights.filter(flight => flight.fromCountryId === 'USA' && flight.toCountryId === 'CHN')), meanRenderMs: frames.reduce((sum, frame) => sum + frame.renderMs, 0) / frames.length, cartesianFrames: frames.filter(frame => frame.cartesian).length, frameCount: frames.length, flights: flights.length }
})
await mkdir('docs/whole-planet', { recursive: true })
await writeFile(`docs/whole-planet/${group}.json`, JSON.stringify({ group, browser: reports[0].browser, cpuRate: reports[0].cpuRate, viewport: [390, 844], dpr: 2, solvedCount: reports[0].solvedCount, holdOverview: group !== 'normal', summary }, null, 2) + '\n')
console.table(summary)
