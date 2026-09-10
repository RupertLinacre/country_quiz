// Opt-in experiments on this branch. Normal URLs keep the shipped renderer.
export type GeometryDetail = 'full' | 'standard' | 'coarse' | 'zoom'
export type RenderExperiment = {
  name: string
  detail: GeometryDetail
  canvasScale: number | null
  adaptive?: boolean
  preserveIslands?: boolean
  zoomPixels?: number
  zoomBase?: 'full' | 'standard'
  cartesian?: boolean
}

export function readRenderExperiment(search: string): RenderExperiment | null {
  const name = new URLSearchParams(search).get('renderExperiment')
  if (name === 'svg-planet') return { name, detail: 'zoom', canvasScale: null, zoomPixels: 1, zoomBase: 'standard', cartesian: true }
  if (name === 'svg-cartesian') return { name, detail: 'standard', canvasScale: null, cartesian: true }
  if (name === 'svg-zoom-adaptive') return { name, detail: 'zoom', canvasScale: null, adaptive: true, zoomPixels: 1, zoomBase: 'standard' }
  const zoom = name?.match(/^svg-zoom-(standard-)?(05|1|2)$/)
  if (zoom) return { name: name!, detail: 'zoom', canvasScale: null, zoomPixels: zoom[2] === '05' ? 0.5 : Number(zoom[2]), zoomBase: zoom[1] ? 'standard' : 'full' }
  const variants: Record<string, [GeometryDetail, number | null]> = {
    'svg-standard': ['standard', null],
    'svg-full': ['full', null],
    'svg-coarse': ['coarse', null],
    'svg-islands': ['coarse', null],
    'svg-adaptive': ['standard', null],
    'canvas-100': ['standard', 1],
    'canvas-75': ['standard', 0.75],
    'canvas-50': ['standard', 0.5],
    'canvas-50-full': ['full', 0.5],
  }
  if (!name || !Object.hasOwn(variants, name)) return null
  const [detail, canvasScale] = variants[name]
  return { name, detail, canvasScale, adaptive: name === 'svg-adaptive', preserveIslands: name === 'svg-islands' || name === 'svg-adaptive' }
}

type TopologyGeometry = { type: 'Polygon'; arcs: number[][] }
  | { type: 'MultiPolygon'; arcs: number[][][] }
  | { type: 'GeometryCollection'; geometries: TopologyGeometry[] }
export type ExperimentTopology = {
  arcs: number[][][]
  transform: { scale: number[]; translate: number[] }
  objects: { countries: TopologyGeometry; land: TopologyGeometry }
}

export function preserveSmallIslands(standard: ExperimentTopology, coarse: ExperimentTopology): ExperimentTopology {
  // These atlases share arc indices and quantization. Keeping whole shared arcs
  // preserves topology and prevents cracks between land, fills and borders.
  if (standard.arcs.length !== coarse.arcs.length || JSON.stringify(standard.transform) !== JSON.stringify(coarse.transform)
    || JSON.stringify(standard.objects) !== JSON.stringify(coarse.objects)) throw new Error('Experiment requires matching atlas topology')
  const keep = new Set<number>()
  const ring = (indices: number[]) => {
    const ids = indices.map(id => id < 0 ? ~id : id)
    if (ids.reduce((count, id) => count + standard.arcs[id].length - 1, 0) <= 16) ids.forEach(id => keep.add(id))
  }
  const visit = (geometry: TopologyGeometry): void => {
    if (geometry.type === 'GeometryCollection') geometry.geometries.forEach(visit)
    else if (geometry.type === 'Polygon') geometry.arcs.forEach(ring)
    else geometry.arcs.forEach(polygon => polygon.forEach(ring))
  }
  Object.values(standard.objects).forEach(visit)
  return { ...coarse, arcs: coarse.arcs.map((arc, id) => keep.has(id) ? standard.arcs[id] : arc) }
}

export type ExperimentFrame = { renderMs: number; rasterMs: number; detail: GeometryDetail; backend: string; lod?: number | null; scale?: number; maxErrorPx?: number; stages?: Record<string, number>; cartesian?: boolean }
export type DetailTransition = { frame: number; from: GeometryDetail; to: GeometryDetail }
export type ExperimentProbe = { name: string; frames: ExperimentFrame[]; frameIntervals: number[]; startDetail?: GeometryDetail; nextDetail?: GeometryDetail; transitions?: DetailTransition[]; preparationMs?: number }
declare global {
  interface Window { __renderExperiment?: ExperimentProbe }
}

export class AdaptiveDetailExperiment {
  detail: GeometryDetail = 'standard'
  nextDetail: GeometryDetail = 'standard'
  transitions: DetailTransition[] = []
  private badFrames = 0
  private samples: { frameMs: number; renderMs: number; detail: GeometryDetail }[] = []

  start(): void {
    this.detail = this.nextDetail
    this.badFrames = 0
    this.samples = []
    this.transitions = []
  }

  observe(frameMs: number, renderMs: number, visible: boolean): void {
    // Exclude background/suspension gaps and incomplete timing samples.
    if (!visible || frameMs > 250 || frameMs < 4 || !Number.isFinite(frameMs) || !Number.isFinite(renderMs) || renderMs <= 0) {
      this.badFrames = 0
      return
    }
    this.samples.push({ frameMs, renderMs, detail: this.detail })
    // Aim for 30 FPS, with slack for occasional uneven frame delivery. Two
    // consecutive misses trigger a downgrade; never upgrade within a flight.
    this.badFrames = frameMs > 38 ? this.badFrames + 1 : 0
    if (this.badFrames >= 2 && this.detail !== 'coarse') {
      const from = this.detail
      this.detail = from === 'full' ? 'standard' : 'coarse'
      this.nextDetail = this.detail
      this.transitions.push({ frame: this.samples.length, from, to: this.detail })
      this.badFrames = 0
    }
  }

  finish(completed: boolean): void {
    if (!completed) return
    const samples = this.samples.filter(sample => sample.detail === this.detail)
    this.nextDetail = this.detail
    if (samples.length < 20) return
    const percentile90 = (values: number[]) => values.sort((a, b) => a - b)[Math.ceil(values.length * 0.9) - 1]
    const frameMs = percentile90(samples.map(sample => sample.frameMs))
    const renderMs = percentile90(samples.map(sample => sample.renderMs))
    // Use measured CPU headroom as well as delivered FPS. Conservative probes
    // happen on the next flight, when the map has already returned to full detail.
    if (this.detail === 'coarse' && frameMs < 27 && renderMs < 14) this.nextDetail = 'standard'
  }
}

// Draw the same ordered map paths to a real bitmap with a controllable backing
// resolution. Labels, flags, plane, and hit testing stay in the existing SVGs.
// This is a prototype for orthographic flights, not a production renderer switch.
export class CanvasMapExperiment {
  readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D
  private readonly paths = new WeakMap<SVGPathElement, string>()
  private active = false

  constructor(container: HTMLElement, resolutionScale: number) {
    this.scale = resolutionScale
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'globe__experiment-canvas'
    this.canvas.setAttribute('aria-hidden', 'true')
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', display: 'none' })
    container.prepend(this.canvas)
    this.context = this.canvas.getContext('2d')!
  }

  private readonly scale: number

  begin(active: boolean, width: number, height: number, map: SVGGElement): void {
    if (active !== this.active) {
      this.active = active
      this.canvas.style.display = active ? 'block' : 'none'
      for (const child of map.children) {
        if (!child.classList.contains('globe__hit-targets')) (child as SVGElement).style.visibility = active ? 'hidden' : ''
      }
    }
    if (!active) return
    const ratio = (window.devicePixelRatio || 1) * this.scale
    const pixelWidth = Math.ceil(width * ratio), pixelHeight = Math.ceil(height * ratio)
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth
      this.canvas.height = pixelHeight
    }
    this.context.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0)
    this.context.clearRect(0, 0, width, height)
  }

  paintPath(node: SVGPathElement, data: string): boolean {
    if (!this.active || node.classList.contains('globe__hit-target')) return false
    this.paths.set(node, data)
    return true
  }

  draw(map: SVGGElement): void {
    if (!this.active) return
    const parsed = new Map<string, Path2D>()
    const context = this.context
    for (const node of map.querySelectorAll<SVGPathElement>('path')) {
      if (node.closest('.globe__hit-targets') || node.getAttribute('display') === 'none') continue
      const data = this.paths.get(node) ?? node.getAttribute('d') ?? ''
      if (!data) continue
      let path = parsed.get(data)
      if (!path) { path = new Path2D(data); parsed.set(data, path) }
      context.globalAlpha = Number(node.getAttribute('opacity') ?? 1)
      const fill = node.getAttribute('fill') ?? 'black'
      if (fill !== 'none') { context.fillStyle = fill; context.fill(path) }
      const stroke = node.getAttribute('stroke') ?? 'none'
      if (stroke !== 'none') {
        context.strokeStyle = stroke
        context.lineWidth = Number(node.getAttribute('stroke-width') ?? 1)
        context.lineCap = (node.getAttribute('stroke-linecap') ?? 'butt') as CanvasLineCap
        context.lineJoin = (node.getAttribute('stroke-linejoin') ?? 'miter') as CanvasLineJoin
        context.miterLimit = Number(node.getAttribute('stroke-miterlimit') ?? 4)
        context.setLineDash((node.getAttribute('stroke-dasharray') ?? '').split(/[ ,]+/).filter(Boolean).map(Number))
        context.lineDashOffset = Number(node.getAttribute('stroke-dashoffset') ?? 0)
        context.stroke(path)
      }
    }
  }
}
