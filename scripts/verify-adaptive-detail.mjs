import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { AdaptiveDetailExperiment, preserveSmallIslands, readRenderExperiment } from '../src/render-experiments.ts'

// Test timing policy without tying correctness to host speed or browser jitter.
const controller = new AdaptiveDetailExperiment()
const observe = (frameMs, renderMs = 20, visible = true) => controller.observe(frameMs, renderMs, visible)
controller.start()
observe(50)
observe(16)
observe(50)
assert.equal(controller.detail, 'standard', 'isolated misses must not change quality')
observe(50)
assert.equal(controller.detail, 'coarse', 'sustained misses must lower detail')
for (let i = 0; i < 40; i++) observe(16, 4)
assert.equal(controller.detail, 'coarse', 'quality must not oscillate during a flight')
controller.finish(true)
assert.equal(controller.nextDetail, 'standard', 'headroom allows a probe on the next flight')
controller.start()
for (let i = 0; i < 40; i++) observe(16.67, 4)
controller.finish(true)
assert.equal(controller.nextDetail, 'standard', 'fast rendering keeps the shipped flight quality')
controller.start()
for (const invalid of [[60, 5, false], [300, 5, true], [NaN, 5, true], [0, 5, true], [60, 0, true]]) {
  observe(50)
  observe(...invalid)
}
assert.equal(controller.detail, 'standard', 'background, long gaps and invalid samples must break miss streaks')
for (let i = 0; i < 4; i++) observe(50)
assert.equal(controller.detail, 'coarse')
assert.deepEqual(controller.transitions.map(({ from, to }) => [from, to]), [['standard', 'coarse']])
controller.start()
for (let i = 0; i < 40; i++) observe(16.67, 4)
controller.finish(false)
assert.equal(controller.nextDetail, 'coarse', 'cancellation must not promote detail')
controller.start()
for (let i = 0; i < 10; i++) observe(16.67, 4)
controller.finish(true)
assert.equal(controller.nextDetail, 'coarse', 'short samples must not promote detail')

assert.equal(readRenderExperiment(''), null)
assert.equal(readRenderExperiment('?renderExperiment=invalid'), null)
assert.equal(readRenderExperiment('?renderExperiment=toString'), null)
assert.equal(readRenderExperiment('?renderExperiment=__proto__'), null)
assert.equal(readRenderExperiment('?renderExperiment=svg-adaptive').adaptive, true)
assert.equal(readRenderExperiment('?renderExperiment=canvas-50').canvasScale, 0.5)
console.log('Adaptive policy: sustained misses, recovery, cancellation, invalid samples and opt-in parsing passed')

const standard = JSON.parse(await readFile('src/generated/globe-atlas.json'))
const coarse = JSON.parse(await readFile('src/generated/globe-interaction-atlas.json'))
const protectedAtlas = preserveSmallIslands(standard, coarse)
let rings = 0
function verify(geometry) {
  if (geometry.type === 'GeometryCollection') return geometry.geometries.forEach(verify)
  for (const ring of geometry.type === 'Polygon' ? geometry.arcs : geometry.arcs.flat()) {
    const ids = ring.map(id => id < 0 ? ~id : id)
    if (ids.reduce((n, id) => n + standard.arcs[id].length - 1, 0) > 16) continue
    for (const id of ids) assert.deepEqual(protectedAtlas.arcs[id], standard.arcs[id])
    rings++
  }
}
Object.values(standard.objects).forEach(verify)
assert(rings > 0)
assert.equal(protectedAtlas.objects, coarse.objects)
const count = atlas => atlas.arcs.reduce((n, arc) => n + arc.length, 0)
assert(count(protectedAtlas) < count(standard))
console.log(`Island geometry: ${rings} small rings preserved; ${count(protectedAtlas)} vertices versus ${count(standard)} standard and ${count(coarse)} coarse`)
