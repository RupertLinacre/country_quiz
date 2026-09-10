import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { visibleSegments } from './lib/visible-segments.mjs'

const directory = process.argv[2] ?? 'output/playwright/zoom-visual'
const captures = JSON.parse(await readFile(`${directory}/results.json`))
const segments = (capture, layer) => visibleSegments(capture.geometry[layer], capture.geometry.width, capture.geometry.height)
  .map(edge => edge.split('/').map(point => point.split(',').map(Number)))
function distance(point, [a, b]) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy)
}
function directed(source, target) {
  const grid = new Map(), cell = 8, padding = 4
  target.forEach((edge, i) => {
    for (let x = Math.floor((Math.min(edge[0][0], edge[1][0]) - padding) / cell); x <= Math.floor((Math.max(edge[0][0], edge[1][0]) + padding) / cell); x++) {
      for (let y = Math.floor((Math.min(edge[0][1], edge[1][1]) - padding) / cell); y <= Math.floor((Math.max(edge[0][1], edge[1][1]) + padding) / cell); y++) {
        const key = `${x},${y}`
        if (!grid.has(key)) grid.set(key, [])
        grid.get(key).push(i)
      }
    }
  })
  const samples = []
  for (const [a, b] of source) {
    const steps = Math.max(1, Math.ceil(Math.hypot(a[0] - b[0], a[1] - b[1]) / 0.5))
    for (let step = 0; step <= steps; step++) {
      const point = a.map((value, axis) => value + (b[axis] - value) * step / steps)
      const candidates = grid.get(`${Math.floor(point[0] / cell)},${Math.floor(point[1] / cell)}`) ?? []
      let closest = Math.min(...candidates.map(i => distance(point, target[i])))
      if (closest > padding) closest = Math.min(...target.map(edge => distance(point, edge)))
      samples.push(closest)
    }
  }
  return samples
}
const results = []
for (const capture of captures.filter(capture => capture.variant.startsWith('svg-zoom-'))) {
  const base = capture.variant.includes('standard-') ? 'svg-standard' : 'svg-full'
  const reference = captures.find(other => other.variant === base && other.name === capture.name)
  assert(reference, `Missing ${base}/${capture.name}`)
  for (const layer of ['coast', 'borders']) {
    const a = segments(capture, layer), b = segments(reference, layer)
    const samples = [...directed(a, b), ...directed(b, a)].sort((a, b) => a - b)
    results.push({ variant: capture.variant, scene: capture.name, layer, lod: capture.lod, scale: Number(capture.scale), sphereBoundPx: Number(capture.maxErrorPx), samples: samples.length,
      maxPx: samples.at(-1) ?? 0, p99Px: samples[Math.ceil(samples.length * 0.99) - 1] ?? 0,
      overHalfPixel: samples.filter(value => value > 0.5).length,
      overOnePixel: samples.filter(value => value > 1).length,
    })
  }
}
await writeFile(`${directory}/error.json`, JSON.stringify(results, null, 2) + '\n')
console.table(results.map(({ variant, scene, layer, maxPx, p99Px, sphereBoundPx }) => ({ variant, scene, layer, bound: sphereBoundPx.toFixed(3), max: maxPx.toFixed(3), p99: p99Px.toFixed(3) })))
