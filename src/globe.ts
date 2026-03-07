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

import interactionAtlasUrl from './generated/globe-atlas-interaction.json?url'
import settledAtlasUrl from './generated/globe-atlas-settled.json?url'
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
const INTERACTION_SETTLE_DELAY_MS = 120
const MAX_SETTLED_PIXEL_RATIO = 1.5
const MIN_ZOOM = 0.78
const MAX_ZOOM = 18
const FOCUS_COUNTRY_RADIUS_PX = 84
const MIN_COUNTRY_ANGULAR_RADIUS = 0.0025
const UNSOLVED_LAND_FILL = '#34393f'
const SOLVED_COUNTRY_OUTLINE_WIDTH = 2.6
const SOLVED_COUNTRY_OUTLINE_COLOR = 'rgba(8, 18, 28, 0.95)'
const SOLVED_COUNTRY_INLINE_WIDTH = 1.15
const SOLVED_COUNTRY_INLINE_COLOR = 'rgba(255, 232, 173, 0.92)'

function appearanceFill(appearance: SolvedAppearance): string {
  return appearance.kind === 'flag' ? appearance.fallbackFill : appearance.fill
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
  const [interactionTopology, settledTopology] = (await Promise.all([
    fetch(interactionAtlasUrl).then((response) => response.json()),
    fetch(settledAtlasUrl).then((response) => response.json()),
  ])) as [Topology, Topology]

  const interactionAtlas = buildAtlasBundle(interactionTopology, countries)
  const settledAtlas = buildAtlasBundle(settledTopology, countries)
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

  const canvas = document.createElement('canvas')
  canvas.className = 'globe__canvas'
  canvas.setAttribute('aria-hidden', 'true')
  container.append(canvas)

  const labelsSvg = select(container)
    .append('svg')
    .attr('class', 'globe__labels-svg')
    .attr('role', 'img')
    .attr('aria-label', 'Interactive globe showing countries of the world')

  const labelLayer = labelsSvg.append('g').attr('class', 'globe__labels')
  const renderingContext = canvas.getContext('2d')

  if (!renderingContext) {
    throw new Error('Canvas rendering is unavailable in this browser')
  }

  const context = renderingContext
  const projection = geoOrthographic().clipAngle(90).precision(0.3).rotate([-12, -18])
  const path = geoPath(projection, context)
  const measurementPath = geoPath(projection)
  const sphere = { type: 'Sphere' } as GeoPermissibleObjects
  const graticule = geoGraticule10()

  let answeredIds = new Set<string>()
  let currentZoom = 1
  let cssWidth = 760
  let cssHeight = 760
  let flyFrame: number | null = null
  let framePending = false
  let interactionActive = false
  let interactionTimeout: number | null = null
  let appliedPixelRatio = 0

  function activeAtlas(): AtlasBundle {
    return interactionActive ? interactionAtlas : settledAtlas
  }

  function targetPixelRatio(): number {
    const baseRatio = window.devicePixelRatio || 1
    return interactionActive ? 1 : Math.min(baseRatio, MAX_SETTLED_PIXEL_RATIO)
  }

  function currentScale(): number {
    return Math.min(cssWidth, cssHeight) * BASE_SCALE_RATIO * currentZoom
  }

  function clampZoom(nextZoom: number): number {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom))
  }

  function writeRenderState(): void {
    const [rotationLongitude, rotationLatitude] = projection.rotate()
    container.dataset.detailMode = interactionActive ? 'interaction' : 'settled'
    container.dataset.rotationLon = rotationLongitude.toFixed(2)
    container.dataset.rotationLat = rotationLatitude.toFixed(2)
    container.dataset.zoom = currentZoom.toFixed(3)
  }

  function syncCanvasSize(force = false): void {
    const bounds = container.getBoundingClientRect()
    cssWidth = Math.max(1, bounds.width)
    cssHeight = Math.max(1, bounds.height)

    const pixelRatio = targetPixelRatio()
    const nextCanvasWidth = Math.round(cssWidth * pixelRatio)
    const nextCanvasHeight = Math.round(cssHeight * pixelRatio)

    if (
      !force &&
      canvas.width === nextCanvasWidth &&
      canvas.height === nextCanvasHeight &&
      appliedPixelRatio === pixelRatio
    ) {
      projection.translate([cssWidth / 2, cssHeight / 2]).scale(currentScale())
      labelsSvg.attr('viewBox', `0 0 ${cssWidth} ${cssHeight}`)
      scheduleRender()
      return
    }

    canvas.width = nextCanvasWidth
    canvas.height = nextCanvasHeight
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    appliedPixelRatio = pixelRatio

    projection.translate([cssWidth / 2, cssHeight / 2]).scale(currentScale())
    labelsSvg.attr('viewBox', `0 0 ${cssWidth} ${cssHeight}`)
    scheduleRender()
  }

  function clearLabels(): void {
    labelLayer.selectAll('text').remove()
  }

  function drawPath(geometry: GeoPermissibleObjects): void {
    context.beginPath()
    path(geometry)
  }

  function isVisible(coordinates: [number, number]): boolean {
    const [rotationLongitude, rotationLatitude] = projection.rotate()
    const center: [number, number] = [-rotationLongitude, -rotationLatitude]
    return geoDistance(center, coordinates) < Math.PI / 2 - 0.05
  }

  function centroidForCountry(countryId: string): [number, number] | null {
    return (
      fallbackCentroidByCountryId.get(countryId) ??
      settledAtlas.countryCentroidById.get(countryId) ??
      interactionAtlas.countryCentroidById.get(countryId) ??
      null
    )
  }

  function featureForCountry(countryId: string): AtlasFeature | null {
    return (
      fallbackFeatureByCountryId.get(countryId) ??
      activeAtlas().featureByCountryId.get(countryId) ??
      settledAtlas.featureByCountryId.get(countryId) ??
      null
    )
  }

  function labelFeatureForCountry(countryId: string): GeoPermissibleObjects | null {
    return (
      fallbackLabelFeatureByCountryId.get(countryId) ??
      settledAtlas.labelFeatureByCountryId.get(countryId) ??
      interactionAtlas.labelFeatureByCountryId.get(countryId) ??
      featureForCountry(countryId)
    )
  }

  function angularRadiusForCountry(countryId: string): number | null {
    return (
      fallbackAngularRadiusByCountryId.get(countryId) ??
      settledAtlas.countryAngularRadiusById.get(countryId) ??
      interactionAtlas.countryAngularRadiusById.get(countryId) ??
      null
    )
  }

  function zoomForCountry(countryId: string): number {
    const angularRadius = angularRadiusForCountry(countryId) ?? MIN_COUNTRY_ANGULAR_RADIUS
    const baseScale = Math.min(cssWidth, cssHeight) * BASE_SCALE_RATIO
    const targetZoom = FOCUS_COUNTRY_RADIUS_PX / Math.max(baseScale * angularRadius, 0.0001)
    return clampZoom(targetZoom)
  }

  function strokeSolvedCountry(feature: AtlasFeature): void {
    context.save()
    context.lineJoin = 'round'
    context.lineCap = 'round'

    drawPath(feature)
    context.strokeStyle = SOLVED_COUNTRY_OUTLINE_COLOR
    context.lineWidth = SOLVED_COUNTRY_OUTLINE_WIDTH
    context.stroke()

    drawPath(feature)
    context.strokeStyle = SOLVED_COUNTRY_INLINE_COLOR
    context.lineWidth = SOLVED_COUNTRY_INLINE_WIDTH
    context.stroke()

    context.restore()
  }

  function renderLabels(): void {
    if (interactionActive) {
      clearLabels()
      return
    }

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
      .selectAll<SVGTextElement, GlobeLabel>('text')
      .data(visibleLabels, (label: GlobeLabel) => label.id)
      .join(
        (enter: Selection<EnterElement, GlobeLabel, SVGGElement, unknown>) =>
          enter.append('text')
            .attr('class', 'globe__label')
            .attr('text-anchor', 'middle')
            .call((textSelection) => {
              textSelection.append('tspan').attr('class', 'globe__label-name')
              textSelection
                .append('tspan')
                .attr('class', 'globe__label-flag')
                .attr('x', 0)
                .attr('dy', '1.25em')
            }),
        (update: Selection<SVGTextElement, GlobeLabel, SVGGElement, unknown>) => update,
        (exit: Selection<SVGTextElement, GlobeLabel, SVGGElement, unknown>) => exit.remove(),
      )
      .attr('x', (label: GlobeLabel) => label.x)
      .attr('y', (label: GlobeLabel) => label.y)
      .each(function (label: GlobeLabel) {
        const textSelection = select(this)
        textSelection.select<SVGTSpanElement>('.globe__label-name').text(label.name).attr('x', label.x)
        textSelection
          .select<SVGTSpanElement>('.globe__label-flag')
          .text(label.flagEmoji)
          .attr('x', label.x)
      })
  }

  function renderNow(): void {
    const atlas = activeAtlas()

    projection.scale(currentScale())
    writeRenderState()
    context.clearRect(0, 0, cssWidth, cssHeight)

    drawPath(sphere)
    context.fillStyle = '#0a4270'
    context.fill()

    context.save()
    drawPath(sphere)
    context.clip()

    if (!interactionActive) {
      drawPath(graticule)
      context.strokeStyle = 'rgba(168, 212, 244, 0.2)'
      context.lineWidth = 0.7
      context.stroke()
    }

    drawPath(atlas.landFeature)
    context.fillStyle = UNSOLVED_LAND_FILL
    context.fill()

    for (const [countryId, fallbackFeature] of fallbackFeatureByCountryId) {
      if (answeredIds.has(countryId)) {
        continue
      }

      drawPath(fallbackFeature)
      context.fillStyle = UNSOLVED_LAND_FILL
      context.fill()
    }

    for (const countryId of answeredIds) {
      const country = countryById.get(countryId)
      const countryFeature = featureForCountry(countryId)

      if (!country || !countryFeature) {
        continue
      }

      drawPath(countryFeature)
      context.fillStyle = appearanceFill(country.appearance)
      context.fill()

      strokeSolvedCountry(countryFeature)
    }

    drawPath(atlas.landFeature)
    context.strokeStyle = interactionActive ? 'rgba(229, 243, 252, 0.45)' : 'rgba(229, 243, 252, 0.7)'
    context.lineWidth = interactionActive ? 1 : 1.15
    context.stroke()

    if (!interactionActive) {
      drawPath(atlas.borderMesh)
      context.strokeStyle = 'rgba(227, 238, 247, 0.38)'
      context.lineWidth = 0.62
      context.stroke()
    }

    for (const [countryId, fallbackFeature] of fallbackFeatureByCountryId) {
      const country = countryById.get(countryId)
      const answered = Boolean(country && answeredIds.has(countryId))

      drawPath(fallbackFeature)
      context.strokeStyle = answered
        ? 'rgba(125, 80, 0, 0.9)'
        : interactionActive
          ? 'rgba(229, 243, 252, 0.4)'
          : 'rgba(227, 238, 247, 0.7)'
      context.lineWidth = answered ? 0.85 : interactionActive ? 0.7 : 0.95
      context.stroke()
    }

    context.restore()

    drawPath(sphere)
    context.strokeStyle = 'rgba(180, 225, 255, 0.55)'
    context.lineWidth = 2.2
    context.stroke()

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

  function enterInteractionMode(): void {
    if (interactionTimeout !== null) {
      window.clearTimeout(interactionTimeout)
      interactionTimeout = null
    }

    if (!interactionActive) {
      interactionActive = true
      syncCanvasSize(true)
      clearLabels()
    }
  }

  function scheduleInteractionSettle(): void {
    if (interactionTimeout !== null) {
      window.clearTimeout(interactionTimeout)
    }

    interactionTimeout = window.setTimeout(() => {
      interactionActive = false
      interactionTimeout = null
      syncCanvasSize(true)
      scheduleRender()
    }, INTERACTION_SETTLE_DELAY_MS)
  }

  function applyZoom(nextZoom: number): void {
    currentZoom = clampZoom(nextZoom)
    scheduleRender()
  }

  function focusCountry(countryId: string): void {
    const centroid = centroidForCountry(countryId)

    if (!centroid) {
      return
    }

    cancelFlyAnimation()
    enterInteractionMode()

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
      scheduleInteractionSettle()
    }

    flyFrame = window.requestAnimationFrame(tick)
  }

  const resizeObserver = new ResizeObserver(() => {
    syncCanvasSize()
  })
  resizeObserver.observe(container)
  syncCanvasSize(true)

  const dragBehavior = drag<HTMLCanvasElement, unknown>()
    .on('start', () => {
      cancelFlyAnimation()
      enterInteractionMode()
    })
    .on('drag', (event: D3DragEvent<HTMLCanvasElement, unknown, unknown>) => {
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
    .on('end', () => {
      scheduleInteractionSettle()
    })

  select(canvas).call(dragBehavior)

  canvas.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      event.preventDefault()
      cancelFlyAnimation()
      enterInteractionMode()
      applyZoom(currentZoom * (event.deltaY < 0 ? 1.18 : 0.84))
      scheduleInteractionSettle()
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
      enterInteractionMode()
      applyZoom(currentZoom * factor)
      scheduleInteractionSettle()
    },
  }
}
