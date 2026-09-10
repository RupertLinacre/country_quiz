import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { geoArea, geoInterpolate } from 'd3'
import { feature } from 'topojson-client'
import { ZoomDetailSelector, materializeZoomLevel } from '../src/zoom-detail.ts'
import { decodeArcs, segmentDistance, vector } from './lib/spherical-lod.mjs'
import { readRenderExperiment } from '../src/render-experiments.ts'

let arcsChecked = 0, curvesChecked = 0, ringsChecked = 0, selections = 0
for (const [base, name] of [['full', 'globe-detail-atlas'], ['standard', 'globe-atlas']]) {
  const source = await readFile(`src/generated/${name}.json`)
  const topology = JSON.parse(source)
  const data = JSON.parse(await readFile(`src/generated/zoom-lod-${base}.json`))
  assert.equal(data.sourceHash, createHash('sha256').update(source).digest('hex'), 'Regenerate LOD indices when the source atlas changes')
  const original = decodeArcs(topology)
  const selector = new ZoomDetailSelector()
  for (const budget of [0.5, 1, 2]) {
    // A gradual zoom in/out with jitter must never exceed the quality cap.
    for (const scales of [Array.from({ length: 600 }, (_, i) => 60 * 1.012 ** i), Array.from({ length: 600 }, (_, i) => 60 * 1.012 ** (599 - i))]) {
      for (const scale of scales) {
        const level = selector.select(data.levels, scale, budget)
        if (level !== null) assert(data.levels[level].maxError * scale <= budget)
        selections++
      }
    }
  }
  const originals = feature(topology, topology.objects.countries).features
  for (const level of data.levels) {
    const result = materializeZoomLevel(topology, level)
    const decoded = decodeArcs(result)
    assert.equal(result.objects, topology.objects, 'Shared ring/arc topology must not change')
    for (let id = 0; id < original.length; id++) {
      const indices = level.indices[id] ?? original[id].map((_, i) => i)
      assert.deepEqual(decoded[id], indices.map(index => original[id][index]), 'Every retained vertex must match exactly')
      assert.equal(indices[0], 0)
      assert.equal(indices.at(-1), original[id].length - 1)
      arcsChecked++
      // Independent sampled check using D3's spherical interpolator. The
      // replacement great-circle is approximated by tiny 3D chords here.
      for (let i = 1; i < indices.length; i++) {
        const start = indices[i - 1], end = indices[i]
        if (end - start < 2) continue
        const interpolate = geoInterpolate(original[id][start], original[id][end])
        const curve = Array.from({ length: 17 }, (_, step) => vector(interpolate(step / 16)))
        for (let index = start; index < end; index++) {
          const edge = geoInterpolate(original[id][index], original[id][index + 1])
          for (const t of [0, 0.5, 1]) {
            const p = vector(edge(t))
            const error = Math.min(...curve.slice(1).map((b, j) => segmentDistance(p, curve[j], b)))
            // Chord approximation of the replacement curve has its own small
            // sagitta. Bound it independently using the geodesic angle.
            const approximation = 1 - Math.cos(interpolate.distance / 32)
            assert(error <= level.maxError + approximation + 1e-12, `${base}: continuous spherical error exceeded`)
            curvesChecked++
          }
        }
      }
    }
    const features = feature(result, result.objects.countries).features
    for (let i = 0; i < features.length; i++) {
      const rings = geometry => geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat()
      const expected = rings(originals[i].geometry), actual = rings(features[i].geometry)
      assert.equal(actual.length, expected.length)
      actual.forEach((ring, j) => {
        if (new Set(expected[j].map(point => point.join(','))).size >= 3) assert(new Set(ring.map(point => point.join(','))).size >= 3, 'No island may collapse to a line')
        const complement = points => geoArea({ type: 'Polygon', coordinates: [points] }) > 2 * Math.PI
        assert.equal(complement(ring), complement(expected[j]), 'Ring winding must remain stable')
        ringsChecked++
      })
    }
  }
}

const selector = new ZoomDetailSelector()
const levels = [{ maxError: 0.01 }, { maxError: 0.005 }]
assert.equal(selector.select(levels, 90, 1), 1)
assert.equal(selector.select(levels, 99, 1), 1)
assert.equal(selector.select(levels, 84, 1), 0)
assert.equal(selector.select(levels, 101, 1), 1, 'Refine immediately above the limit')
assert.equal(selector.select(levels, 300, 1), null, 'Use the source when no LOD meets the limit')
assert.equal(readRenderExperiment('?renderExperiment=svg-zoom-standard-1').zoomPixels, 1)
assert.equal(readRenderExperiment('?renderExperiment=svg-zoom-adaptive').adaptive, true)
console.log({ arcsChecked, curvesChecked, ringsChecked, selections, hysteresis: 'passed' })
