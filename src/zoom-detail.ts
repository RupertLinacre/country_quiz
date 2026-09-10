import type { ExperimentTopology } from './render-experiments'

export type ZoomLevel = { tolerance: number; maxError: number; points: number; indices: (number[] | null)[] }
export type ZoomLevels = { sourceHash: string; levels: ZoomLevel[] }

export function materializeZoomLevel(source: ExperimentTopology, level: ZoomLevel): ExperimentTopology {
  return { ...source, arcs: source.arcs.map((arc, id) => {
    const indices = level.indices[id]
    if (indices === null) return arc
    const selected = new Set(indices)
    let x = 0, y = 0, previousX = 0, previousY = 0
    const result: number[][] = []
    arc.forEach(([dx, dy], i) => {
      x += dx; y += dy
      if (selected.has(i)) { result.push([x - previousX, y - previousY]); previousX = x; previousY = y }
    })
    return result
  }) }
}

export class ZoomDetailSelector {
  private selected: number | null = null

  select(levels: ZoomLevel[], scale: number, maxPixelError: number): number | null {
    // Refine immediately when the quality bound is exceeded. Require 15%
    // headroom before coarsening, so small zoom fluctuations do not toggle LOD.
    if (this.selected !== null && levels[this.selected].maxError * scale > maxPixelError) this.selected = null
    const candidate = levels.findIndex(level => level.maxError * scale <= maxPixelError * 0.85)
    if (candidate !== -1 && (this.selected === null || candidate < this.selected)) this.selected = candidate
    // At initialization/refinement, use the coarsest level meeting the hard cap.
    if (this.selected === null) {
      const exact = levels.findIndex(level => level.maxError * scale <= maxPixelError)
      if (exact !== -1) this.selected = exact
    }
    return this.selected
  }
}
