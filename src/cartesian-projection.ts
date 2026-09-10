import type { GeoProjection, GeoStream } from 'd3'
import type { LineString, Polygon } from 'geojson'

// Orthographic projection is linear in a point's unit-sphere coordinates.
// Cache those coordinates instead of repeating longitude/latitude rotations,
// inverse trig, and forward trig for every vertex on every animation frame.
const vectors = new WeakMap<number[][], Float64Array>()
const safeLines = new WeakMap<number[][], boolean>()
const radians = Math.PI / 180
const cos30 = Math.cos(Math.PI / 6)

function prepareRing(ring: number[][]): Float64Array {
  let result = vectors.get(ring)
  if (!result) {
    result = new Float64Array(ring.length * 3)
    ring.forEach(([longitude, latitude], index) => {
      const cos = Math.cos(latitude * radians)
      result![index * 3] = cos * Math.cos(longitude * radians)
      result![index * 3 + 1] = cos * Math.sin(longitude * radians)
      result![index * 3 + 2] = Math.sin(latitude * radians)
    })
    vectors.set(ring, result)
    let safe = true
    for (let i = 3; i < result.length; i += 3) {
      // Antipodal edges have no unique short arc; leave D3's handling intact.
      safe &&= result[i] * result[i - 3] + result[i + 1] * result[i - 2] + result[i + 2] * result[i - 1] > -0.999999
    }
    safeLines.set(ring, safe)
  }
  return result
}

export function canClipCartesianLine(geometry: LineString): boolean {
  prepareRing(geometry.coordinates)
  return safeLines.get(geometry.coordinates) === true
}

export function prepareCartesianGeometry(geometry: Polygon | LineString): void {
  for (const ring of geometry.type === 'Polygon' ? geometry.coordinates : [geometry.coordinates]) prepareRing(ring)
}

export function createCartesianProjection(projection: GeoProjection) {
  const p0 = projection([0, 0])!, p180 = projection([180, 0])!
  const ox = (p0[0] + p180[0]) / 2, oy = (p0[1] + p180[1]) / 2
  const p90 = projection([90, 0])!, pole = projection([0, 90])!
  const xx = p0[0] - ox, xy = p90[0] - ox, xz = pole[0] - ox
  const yx = p0[1] - oy, yy = p90[1] - oy, yz = pole[1] - oy
  const [longitude, latitude] = projection.rotate().map(angle => -angle * radians)
  const vx = Math.cos(latitude) * Math.cos(longitude), vy = Math.cos(latitude) * Math.sin(longitude), vz = Math.sin(latitude)
  const delta2 = projection.precision() ** 2
  let sink: GeoStream

  // D3's adaptive subdivision criteria, evaluated directly on the sphere.
  // Keep its 30-degree angular guard and midpoint-position guard as well as
  // pixel error: a simple fixed subdivision would fail near the horizon.
  function resample(ax: number, ay: number, az: number, px: number, py: number,
    bx: number, by: number, bz: number, qx: number, qy: number, depth: number): void {
    const dx = qx - px, dy = qy - py, d2 = dx * dx + dy * dy
    if (!delta2 || d2 <= 4 * delta2 || !depth) return
    const length = Math.hypot(ax + bx, ay + by, az + bz)
    const mx = (ax + bx) / length, my = (ay + by) / length, mz = (az + bz) / length
    const sx = ox + xx * mx + xy * my + xz * mz, sy = oy + yx * mx + yy * my + yz * mz
    const dx2 = sx - px, dy2 = sy - py, cross = dy * dx2 - dx * dy2
    if (cross * cross / d2 > delta2 || Math.abs((dx * dx2 + dy * dy2) / d2 - 0.5) > 0.3 || ax * bx + ay * by + az * bz < cos30) {
      resample(ax, ay, az, px, py, mx, my, mz, sx, sy, depth - 1)
      sink.point(sx, sy)
      resample(mx, my, mz, sx, sy, bx, by, bz, qx, qy, depth - 1)
    }
  }

  function ring(points: Float64Array, closed: boolean): void {
    const count = points.length - (closed ? 3 : 0)
    sink.lineStart()
    if (count) {
      let ax = points[0], ay = points[1], az = points[2]
      let px = ox + xx * ax + xy * ay + xz * az, py = oy + yx * ax + yy * ay + yz * az
      sink.point(px, py)
      for (let i = 3; i <= count; i += 3) {
        if (i === count && !closed) break
        const j = i === count ? 0 : i
        const bx = points[j], by = points[j + 1], bz = points[j + 2]
        const qx = ox + xx * bx + xy * by + xz * bz, qy = oy + yx * bx + yy * by + yz * bz
        resample(ax, ay, az, px, py, bx, by, bz, qx, qy, 16)
        if (i !== count) sink.point(qx, qy)
        ax = bx; ay = by; az = bz; px = qx; py = qy
      }
    }
    sink.lineEnd()
  }

  // Intersect short great-circle line segments with the front hemisphere in
  // 3D. Polygon clipping remains on the established D3 route.
  function clippedLine(points: Float64Array): void {
    let started = false
    for (let i = 3; i < points.length; i += 3) {
      let ax = points[i - 3], ay = points[i - 2], az = points[i - 1]
      let bx = points[i], by = points[i + 1], bz = points[i + 2]
      const ad = ax * vx + ay * vy + az * vz, bd = bx * vx + by * vy + bz * vz
      if (ad <= 0 && bd <= 0) continue
      if ((ad > 0) !== (bd > 0)) {
        const t = ad / (ad - bd)
        let cx = ax + t * (bx - ax), cy = ay + t * (by - ay), cz = az + t * (bz - az)
        const length = Math.hypot(cx, cy, cz)
        cx /= length; cy /= length; cz /= length
        if (ad > 0) { bx = cx; by = cy; bz = cz }
        else { ax = cx; ay = cy; az = cz }
      }
      const px = ox + xx * ax + xy * ay + xz * az, py = oy + yx * ax + yy * ay + yz * az
      const qx = ox + xx * bx + xy * by + xz * bz, qy = oy + yx * bx + yy * by + yz * bz
      if (!started) { sink.lineStart(); sink.point(px, py); started = true }
      resample(ax, ay, az, px, py, bx, by, bz, qx, qy, 16)
      sink.point(qx, qy)
      if (bd <= 0) { sink.lineEnd(); started = false }
    }
    if (started) sink.lineEnd()
  }

  return {
    canClip(geometry: LineString): boolean {
      if (!canClipCartesianLine(geometry)) return false
      const points = prepareRing(geometry.coordinates)
      for (let i = 0; i < points.length; i += 3) {
        // Preserve D3's epsilon conventions for vertices exactly on the limb.
        if (Math.abs(points[i] * vx + points[i + 1] * vy + points[i + 2] * vz) < 1e-7) return false
      }
      return true
    },
    stream(geometry: Polygon | LineString, output: GeoStream, clipLine = false): void {
      sink = output
      if (geometry.type === 'Polygon') {
        sink.polygonStart()
        for (const coordinates of geometry.coordinates) ring(prepareRing(coordinates), true)
        sink.polygonEnd()
      } else if (clipLine) clippedLine(prepareRing(geometry.coordinates))
      else ring(prepareRing(geometry.coordinates), false)
    },
  }
}
