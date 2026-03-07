import {
  type D3DragEvent,
  type EnterElement,
  type GeoPermissibleObjects,
  type Selection,
  drag,
  geoArea,
  geoCentroid,
  geoDistance,
  geoGraticule10,
  geoOrthographic,
  geoPath,
  select,
} from 'd3'
import { feature, mesh } from 'topojson-client'

import atlasUrl from './generated/globe-atlas.json?url'
import fallbackFeatures from './generated/country-geometry-fallbacks.json'
import type { QuizCountry, SolvedAppearance } from './quiz-data'

type AtlasFeature = GeoPermissibleObjects & {
  id?: string | number
  properties?: {
    name?: string
  }
}

type Topology = {
  objects: {
    countries: object
    land: object
  }
}

type AtlasBundle = {
  borderMesh: GeoPermissibleObjects
  countryCentroidById: Map<string, [number, number]>
  countryAngularRadiusById: Map<string, number>
  featureByCountryId: Map<string, AtlasFeature>
  labelFeatureByCountryId: Map<string, GeoPermissibleObjects>
  landFeature: GeoPermissibleObjects
}

type GlobeController = {
  focusCountry: (countryId: string) => void
  setAnswered: (answeredIds: Set<string>) => void
  zoomBy: (factor: number) => void
}

type GlobeLabel = {
  id: string
  name: string
  flagEmoji: string
  x: number
  y: number
}

const BASE_SCALE_RATIO = 0.318
const FLY_DURATION_MS = 850
const MIN_ZOOM = 0.78
const MAX_ZOOM = 18
const FOCUS_COUNTRY_RADIUS_PX = 84
const MIN_COUNTRY_ANGULAR_RADIUS = 0.0025
const WHEEL_ZOOM_SENSITIVITY = 0.0034
const MAX_WHEEL_DELTA = 80
const MAP_LABEL_NAME_OFFSET_PX = -4
const MAP_LABEL_FLAG_OFFSET_PX = 17
const SEA_FILL = '#126aa6'
const UNSOLVED_LAND_FILL = '#34393f'
const LATEST_SOLVED_FILL = '#ffe45c'
const SOLVED_COUNTRY_OUTLINE_WIDTH = 2.6
const SOLVED_COUNTRY_OUTLINE_COLOR = 'rgba(8, 18, 28, 0.95)'

function appearanceFill(appearance: SolvedAppearance): string {
  return appearance.kind === 'flag' ? appearance.fallbackFill : appearance.fill
}

function latestAnsweredId(answeredIds: Set<string>): string | null {
  let latestId: string | null = null

  for (const answeredId of answeredIds) {
    latestId = answeredId
  }

  return latestId
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function interpolateNumber(start: number, end: number, t: number): number {
  return start + (end - start) * t
}

function normaliseAtlasId(value: string | number | undefined): string | null {
  if (value === undefined) {
    return null
  }

  return String(value).padStart(3, '0')
}

function shortestLongitudeTarget(startLongitude: number, targetLongitude: number): number {
  const delta = ((targetLongitude - startLongitude + 540) % 360) - 180
  return startLongitude + delta
}

function visitCoordinates(
  value: unknown,
  visitor: (coordinates: [number, number]) => void,
): void {
  if (Array.isArray(value)) {
    if (
      value.length >= 2 &&
      typeof value[0] === 'number' &&
      typeof value[1] === 'number'
    ) {
      visitor([value[0], value[1]])
      return
    }

    for (const entry of value) {
      visitCoordinates(entry, visitor)
    }

    return
  }

  if (!value || typeof value !== 'object') {
    return
  }

  const candidate = value as {
    coordinates?: unknown
    geometries?: unknown[]
    geometry?: unknown
  }

  if (candidate.coordinates !== undefined) {
    visitCoordinates(candidate.coordinates, visitor)
  }

  if (Array.isArray(candidate.geometries)) {
    for (const geometry of candidate.geometries) {
      visitCoordinates(geometry, visitor)
    }
  }

  if (candidate.geometry !== undefined) {
    visitCoordinates(candidate.geometry, visitor)
  }
}

function featureAngularRadius(feature: GeoPermissibleObjects, centroid: [number, number]): number {
  let maxDistance = 0

  visitCoordinates(feature, (coordinates) => {
    maxDistance = Math.max(maxDistance, geoDistance(centroid, coordinates))
  })

  return Math.max(maxDistance, MIN_COUNTRY_ANGULAR_RADIUS)
}

function primaryLabelFeature(feature: AtlasFeature): GeoPermissibleObjects {
  const geometry =
    'geometry' in feature && feature.geometry
      ? (feature.geometry as AtlasFeature)
      : feature

  if (geometry.type === 'Polygon') {
    return geometry
  }

  if (geometry.type !== 'MultiPolygon') {
    return geometry
  }

  const multiPolygonGeometry = geometry as {
    type: 'MultiPolygon'
    coordinates: number[][][][]
  }

  let largestPolygon = multiPolygonGeometry.coordinates[0]
  let largestArea = 0

  for (const polygonCoordinates of multiPolygonGeometry.coordinates) {
    const polygon = {
      type: 'Polygon',
      coordinates: polygonCoordinates,
    } as GeoPermissibleObjects
    const area = geoArea(polygon)

    if (area > largestArea) {
      largestArea = area
      largestPolygon = polygonCoordinates
    }
  }

  return {
    type: 'Polygon',
    coordinates: largestPolygon,
  } as GeoPermissibleObjects
}

function buildAtlasBundle(topology: Topology, countries: QuizCountry[]): AtlasBundle {
  const countryFeatures = (feature(topology as never, topology.objects.countries as never) as unknown as {
    features: AtlasFeature[]
  }).features
  const landFeature = feature(
    topology as never,
    topology.objects.land as never,
  ) as unknown as GeoPermissibleObjects
  const borderMesh = mesh(
    topology as never,
    topology.objects.countries as never,
    ((left: unknown, right: unknown) => left !== right) as never,
  ) as unknown as GeoPermissibleObjects

  const byCcn3 = new Map<string, AtlasFeature>()
  const byName = new Map<string, AtlasFeature>()

  for (const countryFeature of countryFeatures) {
    const atlasId = normaliseAtlasId(countryFeature.id)

    if (atlasId) {
      byCcn3.set(atlasId, countryFeature)
    }

    const featureName = countryFeature.properties?.name

    if (featureName) {
      byName.set(featureName, countryFeature)
    }
  }

  const featureByCountryId = new Map<string, AtlasFeature>()
  const labelFeatureByCountryId = new Map<string, GeoPermissibleObjects>()
  const countryCentroidById = new Map<string, [number, number]>()
  const countryAngularRadiusById = new Map<string, number>()

  for (const country of countries) {
    const matchedFeature =
      byName.get(country.atlasName) ??
      (country.ccn3 ? byCcn3.get(country.ccn3.padStart(3, '0')) : undefined)

    if (!matchedFeature) {
      continue
    }

    featureByCountryId.set(country.id, matchedFeature)
    const labelFeature = primaryLabelFeature(matchedFeature)
    labelFeatureByCountryId.set(country.id, labelFeature)
    const centroid = geoCentroid(labelFeature) as [number, number]
    countryCentroidById.set(country.id, centroid)
    countryAngularRadiusById.set(country.id, featureAngularRadius(labelFeature, centroid))
  }

  return {
    borderMesh,
    countryCentroidById,
    countryAngularRadiusById,
    featureByCountryId,
    labelFeatureByCountryId,
    landFeature,
  }
}

export async function createGlobe(
  container: HTMLElement,
  countries: QuizCountry[],
): Promise<GlobeController> {
  const topology = (await fetch(atlasUrl).then((response) => response.json())) as Topology
  const atlas = buildAtlasBundle(topology, countries)
  const fallbackFeatureByCountryId = new Map<string, AtlasFeature>()
  const fallbackLabelFeatureByCountryId = new Map<string, GeoPermissibleObjects>()
  const fallbackCentroidByCountryId = new Map<string, [number, number]>()
  const fallbackAngularRadiusByCountryId = new Map<string, number>()
  const countryById = new Map(countries.map((country) => [country.id, country]))

  for (const rawFeature of fallbackFeatures as AtlasFeature[]) {
    const atlasId = normaliseAtlasId(rawFeature.id)
    const country = countries.find((candidate) => {
      return candidate.ccn3 === atlasId || candidate.atlasName === rawFeature.properties?.name
    })

    if (!country) {
      continue
    }

    fallbackFeatureByCountryId.set(country.id, rawFeature)
    const labelFeature = primaryLabelFeature(rawFeature)
    fallbackLabelFeatureByCountryId.set(country.id, labelFeature)
    const centroid = geoCentroid(labelFeature) as [number, number]
    fallbackCentroidByCountryId.set(country.id, centroid)
    fallbackAngularRadiusByCountryId.set(country.id, featureAngularRadius(labelFeature, centroid))
  }

  container.replaceChildren()

  const mapSvg = select(container)
    .append('svg')
    .attr('class', 'globe__map-svg')
    .attr('aria-hidden', 'true')

  const labelsSvg = select(container)
    .append('svg')
    .attr('class', 'globe__labels-svg')
    .attr('role', 'img')
    .attr('aria-label', 'Interactive globe showing countries of the world')

  const mapLayer = mapSvg.append('g').attr('class', 'globe__map')
  const spherePath = mapLayer.append('path').attr('class', 'globe__sphere')
  const graticulePath = mapLayer.append('path').attr('class', 'globe__graticule')
  const countriesLayer = mapLayer.append('g').attr('class', 'globe__countries')
  const fallbackLayer = mapLayer.append('g').attr('class', 'globe__fallbacks')
  const solvedLayer = mapLayer.append('g').attr('class', 'globe__solved')
  const coastlinePath = mapLayer.append('path').attr('class', 'globe__coastlines')
  const borderPath = mapLayer.append('path').attr('class', 'globe__borders')
  const fallbackOutlineLayer = mapLayer.append('g').attr('class', 'globe__fallback-outlines')
  const labelLayer = labelsSvg.append('g').attr('class', 'globe__labels')
  const projection = geoOrthographic().clipAngle(90).precision(0.6).rotate([-12, -18])
  const measurementPath = geoPath(projection)
  const sphere = { type: 'Sphere' } as GeoPermissibleObjects
  const graticule = geoGraticule10()

  let answeredIds = new Set<string>()
  let currentZoom = 1
  let cssWidth = 760
  let cssHeight = 760
  let flyFrame: number | null = null
  let framePending = false

  function currentScale(): number {
    return Math.min(cssWidth, cssHeight) * BASE_SCALE_RATIO * currentZoom
  }

  function clampZoom(nextZoom: number): number {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom))
  }

  function writeRenderState(): void {
    const [rotationLongitude, rotationLatitude] = projection.rotate()
    container.dataset.detailMode = 'settled'
    container.dataset.rotationLon = rotationLongitude.toFixed(2)
    container.dataset.rotationLat = rotationLatitude.toFixed(2)
    container.dataset.zoom = currentZoom.toFixed(3)
  }

  function syncCanvasSize(): void {
    const bounds = container.getBoundingClientRect()
    cssWidth = Math.max(1, bounds.width)
    cssHeight = Math.max(1, bounds.height)

    projection.translate([cssWidth / 2, cssHeight / 2]).scale(currentScale())
    mapSvg.attr('viewBox', `0 0 ${cssWidth} ${cssHeight}`)
    labelsSvg.attr('viewBox', `0 0 ${cssWidth} ${cssHeight}`)
    scheduleRender()
  }

  function projectedPathData(geometry: GeoPermissibleObjects): string {
    return measurementPath(geometry) ?? ''
  }

  function isVisible(coordinates: [number, number]): boolean {
    const [rotationLongitude, rotationLatitude] = projection.rotate()
    const center: [number, number] = [-rotationLongitude, -rotationLatitude]
    return geoDistance(center, coordinates) < Math.PI / 2 - 0.05
  }

  function centroidForCountry(countryId: string): [number, number] | null {
    return (
      fallbackCentroidByCountryId.get(countryId) ??
      atlas.countryCentroidById.get(countryId) ??
      null
    )
  }

  function featureForCountry(countryId: string): AtlasFeature | null {
    return (
      fallbackFeatureByCountryId.get(countryId) ??
      atlas.featureByCountryId.get(countryId) ??
      null
    )
  }

  function labelFeatureForCountry(countryId: string): GeoPermissibleObjects | null {
    return (
      fallbackLabelFeatureByCountryId.get(countryId) ??
      atlas.labelFeatureByCountryId.get(countryId) ??
      featureForCountry(countryId)
    )
  }

  function angularRadiusForCountry(countryId: string): number | null {
    return (
      fallbackAngularRadiusByCountryId.get(countryId) ??
      atlas.countryAngularRadiusById.get(countryId) ??
      null
    )
  }

  function zoomForCountry(countryId: string): number {
    const angularRadius = angularRadiusForCountry(countryId) ?? MIN_COUNTRY_ANGULAR_RADIUS
    const baseScale = Math.min(cssWidth, cssHeight) * BASE_SCALE_RATIO
    const targetZoom = FOCUS_COUNTRY_RADIUS_PX / Math.max(baseScale * angularRadius, 0.0001)
    return clampZoom(targetZoom)
  }

  function renderLabels(): void {
    const visibleLabels = [...answeredIds]
      .map((countryId) => {
        const country = countryById.get(countryId)
        const centroid = centroidForCountry(countryId)
        const labelFeature = labelFeatureForCountry(countryId)

        if (!country || !centroid || !labelFeature || !isVisible(centroid)) {
          return null
        }

        const projected = measurementPath.centroid(labelFeature)

        if (!projected || Number.isNaN(projected[0]) || Number.isNaN(projected[1])) {
          return null
        }

        return {
          id: country.id,
          name: country.name,
          flagEmoji: country.flagEmoji,
          x: projected[0],
          y: projected[1],
        }
      })
      .filter((label): label is GlobeLabel => Boolean(label))

    labelLayer
      .selectAll<SVGGElement, GlobeLabel>('g.globe__label')
      .data(visibleLabels, (label: GlobeLabel) => label.id)
      .join(
        (enter: Selection<EnterElement, GlobeLabel, SVGGElement, unknown>) =>
          enter.append('g')
            .attr('class', 'globe__label')
            .call((groupSelection) => {
              groupSelection
                .append('text')
                .attr('class', 'globe__label-name')
                .attr('text-anchor', 'middle')
              groupSelection
                .append('text')
                .attr('class', 'globe__label-flag')
                .attr('text-anchor', 'middle')
            }),
        (update: Selection<SVGGElement, GlobeLabel, SVGGElement, unknown>) => update,
        (exit: Selection<SVGGElement, GlobeLabel, SVGGElement, unknown>) => exit.remove(),
      )
      .attr('transform', (label: GlobeLabel) => `translate(${label.x} ${label.y})`)
      .each(function (label: GlobeLabel) {
        const groupSelection = select(this)
        groupSelection
          .select<SVGTextElement>('.globe__label-name')
          .text(label.name)
          .attr('x', 0)
          .attr('y', MAP_LABEL_NAME_OFFSET_PX)
        groupSelection
          .select<SVGTextElement>('.globe__label-flag')
          .text(label.flagEmoji)
          .attr('x', 0)
          .attr('y', MAP_LABEL_FLAG_OFFSET_PX)
      })
  }

  function renderNow(): void {
    projection.scale(currentScale())
    writeRenderState()
    const mostRecentAnsweredId = latestAnsweredId(answeredIds)

    spherePath
      .attr('d', projectedPathData(sphere))
      .attr('fill', SEA_FILL)
      .attr('stroke', 'rgba(180, 225, 255, 0.55)')
      .attr('stroke-width', 2.2)

    graticulePath
      .attr('d', projectedPathData(graticule))
      .attr('fill', 'none')
      .attr('stroke', 'rgba(168, 212, 244, 0.2)')
      .attr('stroke-width', 0.7)

    countriesLayer
      .selectAll<SVGPathElement, GeoPermissibleObjects>('path')
      .data([atlas.landFeature])
      .join('path')
      .attr('d', (featureEntry) => projectedPathData(featureEntry))
      .attr('fill', UNSOLVED_LAND_FILL)
      .attr('stroke', 'none')

    fallbackLayer
      .selectAll<SVGPathElement, AtlasFeature>('path')
      .data([])
      .join('path')
      .attr('d', (fallbackFeature) => projectedPathData(fallbackFeature))
      .attr('fill', UNSOLVED_LAND_FILL)
      .attr('stroke', 'none')

    const visibleSolvedFeatures = [...answeredIds]
      .map((countryId) => {
        const country = countryById.get(countryId)
        const countryFeature = featureForCountry(countryId)
        const solvedCentroid = centroidForCountry(countryId)

        if (!country || !countryFeature) {
          return null
        }

        if (solvedCentroid && !isVisible(solvedCentroid)) {
          return null
        }

        return {
          appearanceFill:
            countryId === mostRecentAnsweredId
              ? LATEST_SOLVED_FILL
              : appearanceFill(country.appearance),
          feature: countryFeature,
          id: countryId,
        }
      })
      .filter((entry): entry is { appearanceFill: string; feature: AtlasFeature; id: string } => Boolean(entry))

    solvedLayer
      .selectAll<SVGPathElement, { appearanceFill: string; feature: AtlasFeature; id: string }>('path')
      .data(visibleSolvedFeatures, (entry) => entry.id)
      .join('path')
      .attr('d', (entry) => projectedPathData(entry.feature))
      .attr('fill', (entry) => entry.appearanceFill)
      .attr('stroke', SOLVED_COUNTRY_OUTLINE_COLOR)
      .attr('stroke-width', SOLVED_COUNTRY_OUTLINE_WIDTH)
      .attr('stroke-linejoin', 'round')
      .attr('stroke-linecap', 'round')

    coastlinePath
      .attr('d', projectedPathData(atlas.landFeature))
      .attr('fill', 'none')
      .attr('stroke', 'rgba(239, 247, 255, 0.76)')
      .attr('stroke-width', 1.3)
      .attr('stroke-linejoin', 'round')
      .attr('stroke-linecap', 'round')

    borderPath
      .attr('d', projectedPathData(atlas.borderMesh))
      .attr('fill', 'none')
      .attr('stroke', 'rgba(227, 238, 247, 0.38)')
      .attr('stroke-width', 0.62)

    const fallbackOutlineData = [...fallbackFeatureByCountryId.entries()].map(([countryId, fallbackFeature]) => {
      const country = countryById.get(countryId)
      const answered = Boolean(country && answeredIds.has(countryId))
      return {
        answered,
        feature: fallbackFeature,
        id: countryId,
      }
    })

    fallbackOutlineLayer
      .selectAll<SVGPathElement, { answered: boolean; feature: AtlasFeature; id: string }>('path')
      .data(fallbackOutlineData, (entry) => entry.id)
      .join('path')
      .attr('d', (entry) => projectedPathData(entry.feature))
      .attr('fill', 'none')
      .attr('stroke', (entry) =>
        entry.answered
          ? 'rgba(125, 80, 0, 0.9)'
          : 'rgba(227, 238, 247, 0.7)',
      )
      .attr('stroke-width', (entry) => (entry.answered ? 0.85 : 0.95))

    renderLabels()
  }

  function scheduleRender(): void {
    if (framePending) {
      return
    }

    framePending = true
    window.requestAnimationFrame(() => {
      framePending = false
      renderNow()
    })
  }

  function cancelFlyAnimation(): void {
    if (flyFrame !== null) {
      window.cancelAnimationFrame(flyFrame)
      flyFrame = null
    }
  }

  function applyZoom(nextZoom: number): void {
    currentZoom = clampZoom(nextZoom)
    scheduleRender()
  }

  function wheelZoomFactor(event: WheelEvent): number {
    const modeScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 18 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 120 : 1
    const clampedDelta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, event.deltaY * modeScale))
    return Math.exp(-clampedDelta * WHEEL_ZOOM_SENSITIVITY)
  }

  function focusCountry(countryId: string): void {
    const centroid = centroidForCountry(countryId)

    if (!centroid) {
      return
    }

    cancelFlyAnimation()

    const [startLongitude, startLatitude, startGamma] = projection.rotate()
    const targetLongitude = shortestLongitudeTarget(startLongitude, -centroid[0])
    const targetLatitude = -centroid[1]
    const startZoom = currentZoom
    const targetZoom = zoomForCountry(countryId)
    const startTime = performance.now()

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startTime) / FLY_DURATION_MS)
      const eased = easeInOutCubic(progress)

      projection.rotate([
        interpolateNumber(startLongitude, targetLongitude, eased),
        interpolateNumber(startLatitude, targetLatitude, eased),
        startGamma,
      ])
      currentZoom = clampZoom(interpolateNumber(startZoom, targetZoom, eased))
      renderNow()

      if (progress < 1) {
        flyFrame = window.requestAnimationFrame(tick)
        return
      }

      flyFrame = null
    }

    flyFrame = window.requestAnimationFrame(tick)
  }

  const resizeObserver = new ResizeObserver(() => {
    syncCanvasSize()
  })
  resizeObserver.observe(container)
  syncCanvasSize()

  const dragBehavior = drag<SVGSVGElement, unknown>()
    .on('start', () => {
      cancelFlyAnimation()
    })
    .on('drag', (event: D3DragEvent<SVGSVGElement, unknown, unknown>) => {
      const [rotationLongitude, rotationLatitude, rotationGamma] = projection.rotate()
      const sensitivity = 72 / currentScale()
      const nextLatitude = Math.max(-75, Math.min(75, rotationLatitude - event.dy * sensitivity))

      projection.rotate([
        rotationLongitude + event.dx * sensitivity,
        nextLatitude,
        rotationGamma,
      ])
      scheduleRender()
    })

  mapSvg.call(dragBehavior)

  const mapSvgNode = mapSvg.node()

  if (!mapSvgNode) {
    throw new Error('Map SVG could not be created')
  }

  mapSvgNode.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      event.preventDefault()
      cancelFlyAnimation()
      applyZoom(currentZoom * wheelZoomFactor(event))
    },
    { passive: false },
  )

  return {
    focusCountry,
    setAnswered(nextAnsweredIds: Set<string>) {
      answeredIds = new Set(nextAnsweredIds)
      scheduleRender()
    },
    zoomBy(factor: number) {
      cancelFlyAnimation()
      applyZoom(currentZoom * factor)
    },
  }
}
