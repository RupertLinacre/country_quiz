import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'

const names = (await readdir('output/playwright')).filter(name => /^zoom-(slow|confirmation|overview|solved|fast|adaptiveSlow|adaptiveFast)-.+\.json$/.test(name)).sort()
const raw = await Promise.all(names.map(name => readFile(`output/playwright/${name}`).then(JSON.parse)))
const round = value => Math.round(value * 100) / 100
const fps = flights => 1000 * flights.reduce((sum, flight) => sum + flight.frameCount, 0) / flights.reduce((sum, flight) => sum + flight.frameCount * flight.averageFrameMs, 0)
function summarize(data) {
  const frames = data.results.flatMap(flight => flight.experiment.frames)
  const intervals = data.results.flatMap(flight => flight.experiment.frameIntervals).sort((a, b) => a - b)
  const routes = [...new Set(data.results.map(flight => `${flight.fromCountryId}-${flight.toCountryId}`))]
  return {
    name: data.name, browser: data.browser, cpuRate: data.cpuRate, pixelRatio: data.pixelRatio, solvedCount: data.solvedCount, startOverview: data.startOverview,
    fps: round(fps(data.results)), p95FrameMs: round(intervals[Math.ceil(intervals.length * 0.95) - 1]),
    repeatFps: [...new Set(data.results.map(flight => flight.repeat))].map(repeat => round(fps(data.results.filter(flight => flight.repeat === repeat)))),
    routes: routes.map(route => ({ route, fps: round(fps(data.results.filter(flight => `${flight.fromCountryId}-${flight.toCountryId}` === route))) })),
    detailFrames: frames.reduce((counts, frame) => ({ ...counts, [frame.detail]: (counts[frame.detail] ?? 0) + 1 }), {}),
    levelFrames: frames.filter(frame => frame.lod !== undefined).reduce((counts, frame) => ({ ...counts, [frame.lod ?? 'source']: (counts[frame.lod ?? 'source'] ?? 0) + 1 }), {}),
    maxSphereErrorPx: round(Math.max(0, ...frames.map(frame => frame.maxErrorPx ?? 0))),
    preparationMs: data.results[0].experiment.preparationMs,
    errors: data.errors,
  }
}
const results = raw.map(summarize)
for (const variant of ['svg-standard', 'svg-zoom-standard-1']) {
  const runs = raw.filter(data => data.name === `zoom-slow-${variant}` || data.name === `zoom-confirmation-${variant}`)
  if (runs.length === 2) results.push(summarize({ ...runs[0], name: `zoom-pooled-${variant}`, results: runs.flatMap((data, i) => data.results.map(flight => ({ ...flight, repeat: flight.repeat + i * 3 }))) }))
}
await mkdir('docs/zoom-detail', { recursive: true })
await writeFile('docs/zoom-detail/results.json', JSON.stringify(results, null, 2) + '\n')
console.table(results.map(row => ({ name: row.name, fps: row.fps, USA_CHN: row.routes.find(route => route.route === 'USA-CHN')?.fps, p95: row.p95FrameMs, details: JSON.stringify(row.detailFrames) })))
