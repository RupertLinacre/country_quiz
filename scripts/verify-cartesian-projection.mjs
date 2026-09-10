import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { geoArea, geoGraticule10, geoOrthographic } from 'd3'
import { feature, mesh } from 'topojson-client'
import { createHemispherePath, prepareHemisphereCartesian } from '../src/hemisphere-path.ts'
import { materializeZoomLevel } from '../src/zoom-detail.ts'

const geometries = [], labels = []
const add = (name, geometry) => {
  geometries.push([name, geometry])
  if (geometry.type === 'Feature') geometry = geometry.geometry
  if (geometry.type === 'Polygon') labels.push([name, geometry])
  if (geometry.type === 'MultiPolygon') for (const coordinates of geometry.coordinates) labels.push([name, { type: 'Polygon', coordinates }])
}
const standard = JSON.parse(await readFile('src/generated/globe-atlas.json'))
const levels = JSON.parse(await readFile('src/generated/zoom-lod-standard.json')).levels
for (const [name, topology] of [['standard', standard], ...levels.map((level, i) => [`lod${i}`, materializeZoomLevel(standard, level)])]) {
  add(`${name}-land`, feature(topology, topology.objects.land))
  add(`${name}-borders`, mesh(topology, topology.objects.countries, (a, b) => a !== b))
  for (const country of feature(topology, topology.objects.countries).features) add(`${name}-${country.id}`, country)
}
for (const country of JSON.parse(await readFile('src/generated/country-geometry-fallbacks.json'))) {
  const normalize = coordinates => geoArea({ type: 'Polygon', coordinates }) > Math.PI * 2 ? coordinates.map(ring => [...ring].reverse()) : coordinates
  country.geometry.coordinates = country.geometry.type === 'Polygon' ? normalize(country.geometry.coordinates) : country.geometry.coordinates.map(normalize)
  add(`fallback-${country.id}`, country)
}
add('graticule', geoGraticule10())
add('antipodal', { type: 'LineString', coordinates: [[0, 0], [180, 0]] })
add('polar', { type: 'LineString', coordinates: [[0, 89.99999], [180, 89.99999]] })
for (const [, geometry] of [...geometries, ...labels]) prepareHemisphereCartesian(geometry)

// Compare displayed curves, rather than requiring the same subdivision count.
// Equivalent interpolation can straddle D3's floating-point split threshold.
function parse(path) {
  const lines = [], tokens = path.match(/[MLZ]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) ?? []
  let line
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i++]
    if (token === 'M') { line = []; lines.push(line) }
    if (token === 'Z') { if (line.length) line.push(line[0]); continue }
    line.push([Number(tokens[i++]), Number(tokens[i++])])
  }
  return lines
}
function distance(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy) || 0))
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy)
}
function curveDistance(a, b) {
  // Spatial buckets keep large coastlines tractable; test endpoints and
  // midpoints in both directions to catch incorrect joins at the horizon.
  const grid = new Map(), key = (x, y) => `${x},${y}`
  for (const line of b) for (let i = 1; i < line.length; i++) {
    const p = line[i - 1], q = line[i]
    for (let x = Math.floor(Math.min(p[0], q[0]) / 8) - 1; x <= Math.floor(Math.max(p[0], q[0]) / 8) + 1; x++) {
      for (let y = Math.floor(Math.min(p[1], q[1]) / 8) - 1; y <= Math.floor(Math.max(p[1], q[1]) / 8) + 1; y++) {
        const k = key(x, y); if (!grid.has(k)) grid.set(k, []); grid.get(k).push([p, q])
      }
    }
  }
  let maximum = 0
  for (const line of a) for (let i = 1; i < line.length; i++) {
    for (const p of [line[i - 1], line[i], [(line[i - 1][0] + line[i][0]) / 2, (line[i - 1][1] + line[i][1]) / 2]]) {
      const segments = grid.get(key(Math.floor(p[0] / 8), Math.floor(p[1] / 8))) ?? []
      maximum = Math.max(maximum, Math.min(...segments.map(([a, b]) => distance(p, a, b))))
    }
  }
  return maximum
}

const rotations = [[0, 0, 0], [90, 0, 0], [90 - 1e-7, 0, 0], [90 + 1e-7, 0, 0], [0, -90, 0], [0, 90, 0], [137, 75, 42], [-80, -65, -35]]
let seed = 1837
for (let i = 0; i < 12; i++) {
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 | 0) >>> 0) / 2 ** 32
  rotations.push([random() * 360 - 180, random() * 180 - 90, random() * 360 - 180])
}
let pathChecks = 0, centroidChecks = 0, maximumPathError = 0, maximumCentroidError = 0
await mkdir('output/playwright/cartesian', { recursive: true })
for (const rotation of rotations) for (const scale of [117.15795, 240]) {
  const projection = geoOrthographic().precision(0.6).clipAngle(90).rotate(rotation).scale(scale).translate([300, 300])
  const reference = createHemispherePath(projection, { width: 600, height: 600, clipPaths: true, clipExtent: true })
  const candidate = createHemispherePath(projection, { width: 600, height: 600, clipPaths: true, clipExtent: true, cartesian: true })
  for (const [name, geometry] of geometries) {
    const expected = reference.path(geometry), actual = candidate.path(geometry)
    if (expected !== actual) {
      const a = parse(expected), b = parse(actual)
      let error
      const ac = a.flat(), bc = b.flat()
      if (a.length === b.length && a.every((line, i) => line.length === b[i].length)) {
        error = Math.max(0, ...ac.map((p, i) => Math.hypot(p[0] - bc[i][0], p[1] - bc[i][1])))
      } else error = Math.max(curveDistance(a, b), curveDistance(b, a))
      if (!(error <= 0.003)) {
        await writeFile('output/playwright/cartesian/mismatch.json', JSON.stringify({ name, rotation, scale, error, geometry, expected, actual }))
        assert.fail(`${name} at ${rotation}/${scale}: curve error ${error}`)
      }
      maximumPathError = Math.max(maximumPathError, error)
    }
    pathChecks++
  }
  for (const [name, geometry] of labels) {
    const expected = reference.centroid(geometry), actual = candidate.centroid(geometry)
    if (expected.some(Number.isNaN)) assert(actual.some(Number.isNaN), name)
    else {
      const error = Math.hypot(actual[0] - expected[0], actual[1] - expected[1])
      assert(error <= 0.01, `${name} at ${rotation}/${scale}: centroid error ${error}`)
      maximumCentroidError = Math.max(maximumCentroidError, error)
    }
    centroidChecks++
  }
  console.log(`Verified ${rotation.map(n => n.toFixed(2)).join(', ')} at ${scale}`)
}
const result = { pathChecks, centroidChecks, maximumPathError, maximumCentroidError }
await writeFile('output/playwright/cartesian/verification.json', JSON.stringify(result, null, 2))
console.log(result)
