import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { geoArea } from 'd3'
import { decodeArcs, simplifyArc } from './lib/spherical-lod.mjs'

for (const [base, filename] of [['full', 'globe-detail-atlas'], ['standard', 'globe-atlas']]) {
  const source = await readFile(`src/generated/${filename}.json`)
  const topology = JSON.parse(source)
  const arcs = decodeArcs(topology)
  const rings = []
  function visit(g) {
    if (g.type === 'GeometryCollection') g.geometries.forEach(visit)
    else if (g.type === 'Polygon') rings.push(...g.arcs)
    else if (g.type === 'MultiPolygon') rings.push(...g.arcs.flat())
  }
  Object.values(topology.objects).forEach(visit)
  const coordinates = (ring, choices) => ring.flatMap((index, i) => {
    const id = index < 0 ? ~index : index
    const points = choices[id].indices.map(point => arcs[id][point])
    if (index < 0) points.reverse()
    return i ? points.slice(1) : points
  })
  const winding = points => geoArea({ type: 'Polygon', coordinates: [points] }) > 2 * Math.PI
  const full = arcs.map(arc => ({ indices: arc.map((_, i) => i) }))
  const originalWinding = rings.map(ring => winding(coordinates(ring, full)))
  const levels = []
  const tolerances = base === 'standard'
    ? Array.from({ length: 9 }, (_, i) => 0.008 / Math.sqrt(2) ** i)
    : [0.008, 0.004, 0.002, 0.001, 0.0005, 0.00025, 0.000125]
  for (const tolerance of tolerances) {
    const choices = arcs.map(arc => simplifyArc(arc, tolerance))
    // Keep shared topology, all islands, and each ring's original winding. Restore
    // whole source arcs if independent simplification degenerates a joined ring.
    let restored = true
    while (restored) {
      restored = false
      rings.forEach((ring, i) => {
        const points = coordinates(ring, choices)
        if (new Set(points.map(point => point.join(','))).size >= 3 && winding(points) === originalWinding[i]) return
        for (const index of ring) {
          const id = index < 0 ? ~index : index
          if (choices[id].indices.length === arcs[id].length) continue
          choices[id] = { ...full[id], maxError: 0 }; restored = true
        }
      })
    }
    const maxError = Math.max(...choices.map(choice => choice.maxError))
    assert(maxError <= tolerance)
    const indices = choices.map((choice, i) => choice.indices.length === arcs[i].length ? null : choice.indices)
    const points = choices.reduce((n, choice) => n + choice.indices.length, 0)
    // A near-identical extra atlas has little performance value. Fall back to
    // the exact source geometry at close zoom instead of storing those levels.
    if (points > topology.arcs.reduce((n, arc) => n + arc.length, 0) * 0.9) continue
    levels.push({ tolerance, maxError, points, indices })
    console.log({ base, tolerance, maxError, points })
  }
  await writeFile(`src/generated/zoom-lod-${base}.json`, JSON.stringify({ sourceHash: createHash('sha256').update(source).digest('hex'), levels }) + '\n')
}
