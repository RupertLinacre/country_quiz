import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'

const output = 'output/playwright'
const names = (await readdir(output)).filter(name => /^experiment-(slow|fast|dense|solved)-.+\.json$/.test(name)).sort()
const percentile = (values, p) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1]
const round = number => Math.round(number * 100) / 100
const summary = []
for (const name of names) {
  const data = JSON.parse(await readFile(`${output}/${name}`))
  const runs = [...new Set(data.results.map(result => result.repeat))].map(repeat => {
    const flights = data.results.filter(result => result.repeat === repeat)
    return flights.reduce((n, flight) => n + flight.frameCount, 0) / flights.reduce((n, flight) => n + flight.frameCount * flight.averageFrameMs, 0) * 1000
  })
  summary.push({
    name: data.name, browser: data.browser, cpuRate: data.cpuRate, pixelRatio: data.pixelRatio, solvedCount: data.solvedCount,
    repeats: runs.length, fps: round(data.fps), repeatFps: runs.map(round),
    p95FrameMs: round(percentile(data.results.flatMap(result => result.experiment.frameIntervals), 0.95)),
    renderCpuMs: round(data.experimentSummary.meanRenderMs), rasterSubmitMs: round(data.experimentSummary.meanRasterSubmitMs),
    details: data.experimentSummary.details,
    routes: data.routeSummaries.map(route => ({ ...route, fps: round(route.fps) })),
    transitions: data.results.flatMap(result => result.experiment.transitions ?? []),
    errors: data.errors,
  })
}
await mkdir('docs/render-experiments', { recursive: true })
await writeFile('docs/render-experiments/results.json', JSON.stringify(summary, null, 2) + '\n')
console.table(summary.map(row => ({ name: row.name, fps: row.fps, USA_CHN: row.routes.find(route => route.from === 'USA' && route.to === 'CHN').fps, p95: row.p95FrameMs, cpu: row.renderCpuMs, details: JSON.stringify(row.details) })))
