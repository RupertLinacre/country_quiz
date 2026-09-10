// Simplify in unit-sphere 3D, before any camera rotation. Orthographic projection
// is a rotation followed by a scaled linear projection, so a 3D distance bound
// becomes a camera-independent bound in CSS pixels when multiplied by scale.
export const vector = ([lon, lat]) => {
  const lambda = lon * Math.PI / 180, phi = lat * Math.PI / 180
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)]
}
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0)
const subtract = (a, b) => a.map((x, i) => x - b[i])
export const sagitta = (a, b) => 1 - Math.sqrt(Math.max(0, (1 + Math.min(1, dot(a, b))) / 2))
export function segmentDistance(p, a, b) {
  const edge = subtract(b, a), offset = subtract(p, a)
  const length2 = dot(edge, edge)
  const t = length2 ? Math.max(0, Math.min(1, dot(offset, edge) / length2)) : 0
  return Math.hypot(...offset.map((x, i) => x - t * edge[i]))
}

export function simplifyArc(points, tolerance) {
  const vectors = points.map(vector)
  const edgeSagitta = vectors.slice(1).map((v, i) => sagitta(vectors[i], v))
  const closed = points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]
  const keep = new Set([0, points.length - 1])
  if (closed && points.length > 3) {
    let far = 1, third = 1, maxDistance = -1
    for (let i = 1; i < points.length - 1; i++) {
      const distance = Math.hypot(...subtract(vectors[i], vectors[0]))
      if (distance > maxDistance) { far = i; maxDistance = distance }
    }
    maxDistance = -1
    for (let i = 1; i < points.length - 1; i++) {
      if (i === far) continue
      const distance = segmentDistance(vectors[i], vectors[0], vectors[far])
      if (distance > maxDistance) { third = i; maxDistance = distance }
    }
    keep.add(far); keep.add(third)
  }
  const anchors = [...keep].sort((a, b) => a - b)
  const stack = anchors.slice(1).map((end, i) => [anchors[i], end])
  let maxError = 0
  while (stack.length) {
    const [start, end] = stack.pop()
    if (end - start < 2) continue // Original great-circle edge is unchanged.
    let maxDistance = -1, split = (start + end) >>> 1, originalSagitta = 0
    for (let i = start; i < end; i++) {
      originalSagitta = Math.max(originalSagitta, edgeSagitta[i])
      if (i === start) continue
      const distance = segmentDistance(vectors[i], vectors[start], vectors[end])
      if (distance > maxDistance) { maxDistance = distance; split = i }
    }
    // Bound the continuous source edges as well as the replacement great-circle
    // arc, rather than checking only the source vertices against a straight line.
    const bound = maxDistance + originalSagitta + sagitta(vectors[start], vectors[end])
    if (bound <= tolerance) maxError = Math.max(maxError, bound)
    else { keep.add(split); stack.push([start, split], [split, end]) }
  }
  const indices = [...keep].sort((a, b) => a - b)
  if (closed && indices.length < 4) return { indices: points.map((_, i) => i), maxError: 0 }
  return { indices, maxError }
}

export function decodeArcs(topology) {
  const { scale, translate } = topology.transform
  return topology.arcs.map(arc => {
    let x = 0, y = 0
    return arc.map(([dx, dy]) => {
      x += dx; y += dy
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]]
    })
  })
}
