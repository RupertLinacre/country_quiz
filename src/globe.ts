import {
  type D3DragEvent,
  type EnterElement,
  type GeoProjection,
  type GeoPermissibleObjects,
  type Selection,
  drag,
  easeCubicInOut,
  geoArea,
  geoCentroid,
  geoDistance,
  geoEqualEarth,
  geoInterpolate,
  geoProjection,
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
  setAnswered: (
    answeredIds: Set<string>,
    options?: {
      cheatedIds?: Set<string>
      focusLatest?: boolean
    },
  ) => void
  syncFlightPath: (
    answerOrder: string[],
    options?: {
      animate?: boolean
    },
  ) => GlobeFlightStatus | null
  setProjectionMode: (mode: ProjectionMode) => void
  zoomBy: (factor: number) => void
}

export type ProjectionMode = 'globe' | 'map'

export type GlobeFlightStatus = {
  fromName: string
  legMiles: number
  toName: string
  totalMiles: number
}

type GlobeLabel = {
  flagAssetUrl: string | null
  id: string
  name: string
  x: number
  y: number
}

type FlightSegment = {
  fromCoordinates: [number, number]
  fromCountryId: string
  fromName: string
  id: string
  miles: number
  pathCoordinates: [number, number][]
  toCoordinates: [number, number]
  toCountryId: string
  toName: string
}

type PinchZoomState = {
  distance: number
  zoom: number
}

type TouchCheatState = {
  countryId: string
  startX: number
  startY: number
  timeoutId: number
}

type ProjectionView = {
  mode: ProjectionMode
  projection: GeoProjection
  measurementPath: ReturnType<typeof geoPath>
  clipOutlinePath: Selection<SVGPathElement, unknown, null, undefined>
  mapRoot: Selection<SVGGElement, unknown, null, undefined>
  labelsRoot: Selection<SVGGElement, unknown, null, undefined>
  mapLayer: Selection<SVGGElement, unknown, null, undefined>
  spherePath: Selection<SVGPathElement, unknown, null, undefined>
  graticulePath: Selection<SVGPathElement, unknown, null, undefined>
  countriesLayer: Selection<SVGGElement, unknown, null, undefined>
  fallbackLayer: Selection<SVGGElement, unknown, null, undefined>
  solvedLayer: Selection<SVGGElement, unknown, null, undefined>
  flightTrailLayer: Selection<SVGGElement, unknown, null, undefined>
  flightActiveLayer: Selection<SVGGElement, unknown, null, undefined>
  coastlinePath: Selection<SVGPathElement, unknown, null, undefined>
  borderPath: Selection<SVGPathElement, unknown, null, undefined>
  fallbackOutlineLayer: Selection<SVGGElement, unknown, null, undefined>
  hitTargetLayer: Selection<SVGGElement, unknown, null, undefined>
  labelLayer: Selection<SVGGElement, unknown, null, undefined>
  planeLayer: Selection<SVGGElement, unknown, null, undefined>
  planeMarker: Selection<SVGGElement, unknown, null, undefined>
  currentZoom: number
  panOffsetX: number
  panOffsetY: number
  baseScale: number
  baseTranslate: [number, number]
}

const BASE_SCALE_RATIO = 0.318
const EARTH_RADIUS_MILES = 3958.7613
const FLIGHT_PATH_SAMPLE_STEP_RADIANS = 0.045
const FLIGHT_START_COUNTRY_ID = 'GBR'
const FLY_DURATION_MS = 1700
const MIN_ZOOM = 0.78
const MAX_ZOOM = 18
const FOCUS_COUNTRY_RADIUS_PX = 84
const MIN_COUNTRY_ANGULAR_RADIUS = 0.0025
const DESKTOP_FLIGHT_TRAILS_MEDIA_QUERY = '(min-width: 841px)'
const PLANE_EMOJI_BASE_HEADING_DEGREES = -45
const PLANE_TANGENT_SAMPLE_STEP = 0.018
const WHEEL_ZOOM_SENSITIVITY = 0.0034
const MAX_WHEEL_DELTA = 80
const MIN_PINCH_DISTANCE_PX = 24
const MOBILE_CHEAT_HOLD_MS = 2000
const MAP_LABEL_NAME_OFFSET_PX = -4
const MAP_LABEL_FLAG_OFFSET_PX = 17
const MAP_LABEL_FLAG_WIDTH_PX = 26
const MAP_LABEL_FLAG_HEIGHT_PX = 18
const MAP_VIEW_PADDING_RATIO = 0.065
const PLANE_LABEL_OFFSET_PX = -MAP_LABEL_FLAG_OFFSET_PX
const PLANE_EMOJI = '✈️'
const PROJECTION_TRANSITION_DURATION_MS = 3000
const PROJECTION_TRANSITION_EDGE_FRACTION = 0.12
const SEA_FILL = '#126aa6'
const UNSOLVED_LAND_FILL = '#34393f'
const LATEST_SOLVED_FILL = '#ffe45c'
const CHEATED_SOLVED_FILL = '#8f59ff'
const SOLVED_COUNTRY_OUTLINE_WIDTH = 2.6
const SOLVED_COUNTRY_OUTLINE_COLOR = 'rgba(8, 18, 28, 0.95)'
const MAX_COUNTRY_POLYGON_AREA = Math.PI * 2

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

function edgeFadeValue(progress: number, edgeFraction: number): number {
  if (progress <= edgeFraction) {
    return progress / edgeFraction
  }

  if (progress >= 1 - edgeFraction) {
    return (1 - progress) / edgeFraction
  }

  return 1
}

function distanceBetweenTouches(firstTouch: Touch, secondTouch: Touch): number {
  return Math.hypot(
    secondTouch.clientX - firstTouch.clientX,
    secondTouch.clientY - firstTouch.clientY,
  )
}

function toMiles(distanceRadians: number): number {
  return Math.round(distanceRadians * EARTH_RADIUS_MILES)
}

function normaliseAtlasId(value: string | number | undefined): string | null {
  if (value === undefined) {
    return null
  }

  return String(value).padStart(3, '0')
}

function normalisePolygonCoordinates(
  coordinates: number[][][],
): number[][][] {
  const polygon = {
    type: 'Polygon',
    coordinates,
  } as GeoPermissibleObjects

  if (geoArea(polygon) <= MAX_COUNTRY_POLYGON_AREA) {
    return coordinates
  }

  return coordinates.map((ring) => [...ring].reverse())
}

function normaliseCountryFeature(feature: AtlasFeature): AtlasFeature {
  if (!('geometry' in feature) || !feature.geometry) {
    return feature
  }

  if (feature.geometry.type === 'Polygon') {
    const geometry = feature.geometry as {
      type: 'Polygon'
      coordinates: number[][][]
    }

    return {
      ...feature,
      geometry: {
        ...geometry,
        coordinates: normalisePolygonCoordinates(geometry.coordinates),
      },
    }
  }

  if (feature.geometry.type === 'MultiPolygon') {
    const geometry = feature.geometry as {
      type: 'MultiPolygon'
      coordinates: number[][][][]
    }

    return {
      ...feature,
      geometry: {
        ...geometry,
        coordinates: geometry.coordinates.map((polygonCoordinates) =>
          normalisePolygonCoordinates(polygonCoordinates),
        ),
      },
    }
  }

  return feature
}

function shortestLongitudeTarget(startLongitude: number, targetLongitude: number): number {
  const delta = ((targetLongitude - startLongitude + 540) % 360) - 180
  return startLongitude + delta
}

function greatArcCoordinates(
  fromCoordinates: [number, number],
  toCoordinates: [number, number],
): [number, number][] {
  const angularDistance = geoDistance(fromCoordinates, toCoordinates)

  if (angularDistance < 0.000001) {
    return [fromCoordinates, toCoordinates]
  }

  const sampleCount = Math.max(
    18,
    Math.ceil(angularDistance / FLIGHT_PATH_SAMPLE_STEP_RADIANS),
  )
  const interpolateCoordinates = geoInterpolate(fromCoordinates, toCoordinates)

  return Array.from({ length: sampleCount + 1 }, (_, index) => {
    return interpolateCoordinates(index / sampleCount) as [number, number]
  })
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
    const matchedFeatureSource =
      byName.get(country.atlasName) ??
      (country.ccn3 ? byCcn3.get(country.ccn3.padStart(3, '0')) : undefined)

    if (!matchedFeatureSource) {
      continue
    }

    const matchedFeature = normaliseCountryFeature(matchedFeatureSource)

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
  options?: {
    onCountryCheat?: (countryId: string) => void
  },
): Promise<GlobeController> {
  const topology = (await fetch(atlasUrl).then((response) => response.json())) as Topology
  const atlas = buildAtlasBundle(topology, countries)
  const fallbackFeatureByCountryId = new Map<string, AtlasFeature>()
  const fallbackLabelFeatureByCountryId = new Map<string, GeoPermissibleObjects>()
  const fallbackCentroidByCountryId = new Map<string, [number, number]>()
  const fallbackAngularRadiusByCountryId = new Map<string, number>()
  const countryById = new Map(countries.map((country) => [country.id, country]))

  for (const rawFeature of fallbackFeatures as AtlasFeature[]) {
    const normalizedFeature = normaliseCountryFeature(rawFeature)
    const atlasId = normaliseAtlasId(rawFeature.id)
    const country = countries.find((candidate) => {
      return candidate.ccn3 === atlasId || candidate.atlasName === rawFeature.properties?.name
    })

    if (!country) {
      continue
    }

    fallbackFeatureByCountryId.set(country.id, normalizedFeature)
    const labelFeature = primaryLabelFeature(normalizedFeature)
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
  const defs = mapSvg.append('defs')

  const labelsSvg = select(container)
    .append('svg')
    .attr('class', 'globe__labels-svg')
    .attr('role', 'img')
    .attr('aria-label', 'Interactive globe showing countries of the world')
  const sphere = { type: 'Sphere' } as GeoPermissibleObjects
  const graticule = geoGraticule10()
  const desktopFlightTrailsMediaQuery = window.matchMedia(DESKTOP_FLIGHT_TRAILS_MEDIA_QUERY)
  let projectionViewIndex = 0

  function createProjectionView(
    mode: ProjectionMode,
    projection: GeoProjection,
  ): ProjectionView {
    const clipPathId = `globe-clip-${projectionViewIndex}-${mode}`
    projectionViewIndex += 1
    const clipOutlinePath = defs.append('clipPath').attr('id', clipPathId).append('path')
    const mapRoot = mapSvg.append('g').attr('class', `globe__view globe__view--${mode}`)
    const labelsRoot = labelsSvg.append('g').attr('class', `globe__view globe__view--${mode}`)
    const mapLayer = mapRoot.append('g').attr('class', 'globe__map')
    const spherePath = mapLayer.append('path').attr('class', 'globe__sphere')
    const graticulePath = mapLayer
      .append('path')
      .attr('class', 'globe__graticule')
      .attr('clip-path', `url(#${clipPathId})`)
    const countriesLayer = mapLayer
      .append('g')
      .attr('class', 'globe__countries')
      .attr('clip-path', `url(#${clipPathId})`)
    const fallbackLayer = mapLayer
      .append('g')
      .attr('class', 'globe__fallbacks')
      .attr('clip-path', `url(#${clipPathId})`)
    const solvedLayer = mapLayer
      .append('g')
      .attr('class', 'globe__solved')
      .attr('clip-path', `url(#${clipPathId})`)
    const flightLayer = mapLayer.append('g').attr('class', 'globe__flights')
    const flightTrailLayer = flightLayer
      .append('g')
      .attr('class', 'globe__flight-trails')
      .attr('clip-path', `url(#${clipPathId})`)
    const flightActiveLayer = flightLayer
      .append('g')
      .attr('class', 'globe__flight-active')
      .attr('clip-path', `url(#${clipPathId})`)
    const coastlinePath = mapLayer
      .append('path')
      .attr('class', 'globe__coastlines')
      .attr('clip-path', `url(#${clipPathId})`)
    const borderPath = mapLayer
      .append('path')
      .attr('class', 'globe__borders')
      .attr('clip-path', `url(#${clipPathId})`)
    const fallbackOutlineLayer = mapLayer
      .append('g')
      .attr('class', 'globe__fallback-outlines')
      .attr('clip-path', `url(#${clipPathId})`)
    const hitTargetLayer = mapLayer
      .append('g')
      .attr('class', 'globe__hit-targets')
      .attr('clip-path', `url(#${clipPathId})`)
    const labelLayer = labelsRoot.append('g').attr('class', 'globe__labels')
    const planeLayer = labelsRoot
      .append('g')
      .attr('class', 'globe__plane-layer')
      .attr('aria-hidden', 'true')
    const planeMarker = planeLayer.append('g').attr('class', 'globe__plane')
    planeMarker.append('circle').attr('class', 'globe__plane-halo')
    planeMarker.append('text').attr('class', 'globe__plane-emoji').text(PLANE_EMOJI)

    return {
      mode,
      projection,
      measurementPath: geoPath(projection),
      clipOutlinePath,
      mapRoot,
      labelsRoot,
      mapLayer,
      spherePath,
      graticulePath,
      countriesLayer,
      fallbackLayer,
      solvedLayer,
      flightTrailLayer,
      flightActiveLayer,
      coastlinePath,
      borderPath,
      fallbackOutlineLayer,
      hitTargetLayer,
      labelLayer,
      planeLayer,
      planeMarker,
      currentZoom: 1,
      panOffsetX: 0,
      panOffsetY: 0,
      baseScale: 1,
      baseTranslate: [0, 0],
    }
  }

  const globeView = createProjectionView(
    'globe',
    geoOrthographic().clipAngle(90).precision(0.6).rotate([-12, -18]),
  )
  const mapView = createProjectionView('map', geoEqualEarth().precision(0.6))
  const transitionView = createProjectionView('map', geoEqualEarth().precision(0.6))
  transitionView.mapRoot
    .attr('class', 'globe__view globe__transition-view')
    .attr('display', 'none')
    .attr('aria-hidden', 'true')
  transitionView.labelsRoot.attr('display', 'none').attr('aria-hidden', 'true')
  transitionView.mapRoot.lower()
  transitionView.labelsRoot.lower()
  for (const layer of [
    transitionView.graticulePath,
    transitionView.countriesLayer,
    transitionView.fallbackLayer,
    transitionView.solvedLayer,
    transitionView.flightTrailLayer,
    transitionView.flightActiveLayer,
    transitionView.coastlinePath,
    transitionView.borderPath,
    transitionView.fallbackOutlineLayer,
    transitionView.hitTargetLayer,
  ]) {
    layer.attr('clip-path', null)
  }
  const projectionViews = [globeView, mapView] as const
  const viewByMode: Record<ProjectionMode, ProjectionView> = {
    globe: globeView,
    map: mapView,
  }

  let answeredIds = new Set<string>()
  let cheatedIds = new Set<string>()
  let flightSegments: FlightSegment[] = []
  let activeFlightSegmentId: string | null = null
  let activeFlightProgress = 1
  let activeMode: ProjectionMode = 'globe'
  let cssWidth = 760
  let cssHeight = 760
  let flyFrame: number | null = null
  let framePending = false
  let planeCoordinates: [number, number] | null = null
  let pinchZoomState: PinchZoomState | null = null
  let projectionTransitionActive = false
  let projectionTransitionProgress = 1
  let projectionTransitionSourceMode: ProjectionMode | null = null
  let projectionTransitionTargetMode: ProjectionMode | null = null
  let showDesktopFlightTrails = desktopFlightTrailsMediaQuery.matches
  let touchCheatState: TouchCheatState | null = null

  function currentView(): ProjectionView {
    return viewByMode[activeMode]
  }

  function currentScale(view: ProjectionView): number {
    return view.baseScale * view.currentZoom
  }

  function clampZoom(nextZoom: number): number {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom))
  }

  function writeRenderState(): void {
    const activeView = currentView()
    const [rotationLongitude, rotationLatitude] = activeView.projection.rotate()
    container.dataset.detailMode = 'settled'
    container.dataset.projectionMode =
      projectionTransitionActive && projectionTransitionTargetMode
        ? projectionTransitionTargetMode
        : activeMode
    container.dataset.transitionFrom = projectionTransitionSourceMode ?? ''
    container.dataset.transitionTo = projectionTransitionTargetMode ?? ''
    container.dataset.transitionProgress = projectionTransitionActive
      ? projectionTransitionProgress.toFixed(3)
      : '1.000'
    container.dataset.rotationLon = rotationLongitude.toFixed(2)
    container.dataset.rotationLat = rotationLatitude.toFixed(2)
    container.dataset.zoom = activeView.currentZoom.toFixed(3)
    container.dataset.panX = activeView.panOffsetX.toFixed(1)
    container.dataset.panY = activeView.panOffsetY.toFixed(1)
  }

  function viewVisibility(view: ProjectionView): number {
    if (
      projectionTransitionActive &&
      projectionTransitionSourceMode &&
      projectionTransitionTargetMode
    ) {
      const sourceFadeOut = 1 - Math.min(1, projectionTransitionProgress / PROJECTION_TRANSITION_EDGE_FRACTION)
      const targetFadeIn =
        1 -
        Math.min(
          1,
          (1 - projectionTransitionProgress) / PROJECTION_TRANSITION_EDGE_FRACTION,
        )

      if (view.mode === projectionTransitionSourceMode) {
        return sourceFadeOut
      }

      if (view.mode === projectionTransitionTargetMode) {
        return targetFadeIn
      }
    }

    return view.mode === activeMode ? 1 : 0
  }

  function applyViewPresentation(view: ProjectionView): void {
    const visibility = viewVisibility(view)
    const displayValue = visibility > 0.001 ? null : 'none'
    const pointerEvents =
      !projectionTransitionActive && view.mode === activeMode ? 'auto' : 'none'

    for (const root of [view.mapRoot, view.labelsRoot]) {
      root
        .attr('display', displayValue)
        .attr('data-active', visibility > 0.5 ? 'true' : 'false')
        .style('opacity', visibility.toFixed(3))
        .style('pointer-events', pointerEvents)
        .style('transform-origin', '50% 50%')
        .style('transform-box', 'fill-box')
        .style('transform', 'none')
        .style('filter', 'none')
    }
  }

  function updateViewVisibility(): void {
    const presentedMode =
      projectionTransitionActive && projectionTransitionTargetMode
        ? projectionTransitionTargetMode
        : activeMode
    container.dataset.projectionMode = presentedMode
    container.dataset.transitioning = projectionTransitionActive ? 'true' : 'false'
    labelsSvg.attr(
      'aria-label',
      presentedMode === 'globe'
        ? 'Interactive globe showing countries of the world'
        : 'Interactive Equal Earth map showing countries of the world',
    )

    for (const view of projectionViews) {
      applyViewPresentation(view)
    }

    const transitionOpacity = projectionTransitionActive
      ? Math.min(
        1,
        edgeFadeValue(projectionTransitionProgress, PROJECTION_TRANSITION_EDGE_FRACTION),
      )
      : 0

    transitionView.mapRoot
      .attr('display', transitionOpacity > 0.001 ? null : 'none')
      .style('opacity', transitionOpacity.toFixed(3))
      .style('pointer-events', 'none')
      .style('filter', transitionOpacity > 0.01 ? 'drop-shadow(0 10px 24px rgba(0, 0, 0, 0.12))' : 'none')
  }

  function seaVisibility(): number {
    return projectionTransitionActive ? 0 : 1
  }

  function syncViewProjection(view: ProjectionView): void {
    if (view.mode === 'globe') {
      const baseScale = Math.min(cssWidth, cssHeight) * BASE_SCALE_RATIO
      view.baseScale = baseScale
      view.baseTranslate = [cssWidth / 2, cssHeight / 2]
      view.projection.translate(view.baseTranslate).scale(currentScale(view))
      return
    }

    const padding = Math.max(20, Math.min(cssWidth, cssHeight) * MAP_VIEW_PADDING_RATIO)
    view.projection.fitExtent(
      [
        [padding, padding],
        [cssWidth - padding, cssHeight - padding],
      ],
      sphere as never,
    )
    const [baseTranslateX, baseTranslateY] = view.projection.translate() as [number, number]
    view.baseTranslate = [baseTranslateX, baseTranslateY]
    view.baseScale = view.projection.scale()
    view.projection
      .scale(currentScale(view))
      .translate([
        view.baseTranslate[0] + view.panOffsetX,
        view.baseTranslate[1] + view.panOffsetY,
      ])
  }

  function cloneProjection(view: ProjectionView): GeoProjection {
    const clonedProjection =
      view.mode === 'globe'
        ? geoOrthographic().clipAngle(90).precision(0.6)
        : geoEqualEarth().precision(0.6)

    clonedProjection
      .scale(view.projection.scale())
      .translate(view.projection.translate())
      .rotate(view.projection.rotate())

    return clonedProjection
  }

  function syncCanvasSize(): void {
    const bounds = container.getBoundingClientRect()
    cssWidth = Math.max(1, bounds.width)
    cssHeight = Math.max(1, bounds.height)

    mapSvg.attr('viewBox', `0 0 ${cssWidth} ${cssHeight}`)
    labelsSvg.attr('viewBox', `0 0 ${cssWidth} ${cssHeight}`)

    for (const view of projectionViews) {
      syncViewProjection(view)
    }

    scheduleRender()
  }

  function projectedPathData(view: ProjectionView, geometry: GeoPermissibleObjects): string {
    return view.measurementPath(geometry) ?? ''
  }

  function morphedProjectedPoint(
    sourceProjection: GeoProjection,
    targetProjection: GeoProjection,
    coordinates: [number, number],
    alpha: number,
  ): [number, number] {
    const sourcePoint = sourceProjection(coordinates)
    const targetPoint = targetProjection(coordinates)
    const sourceTranslate = sourceProjection.translate() as [number, number]
    const targetTranslate = targetProjection.translate() as [number, number]
    const sourceFallback = sourcePoint ?? sourceTranslate
    const targetFallback = targetPoint ?? targetTranslate

    return [
      interpolateNumber(sourceFallback[0], targetFallback[0], alpha),
      interpolateNumber(sourceFallback[1], targetFallback[1], alpha),
    ]
  }

  function createProjectionTweenProjection(
    sourceProjection: GeoProjection,
    targetProjection: GeoProjection,
    alpha: number,
  ): GeoProjection {
    const origin = morphedProjectedPoint(sourceProjection, targetProjection, [0, 0], alpha)
    const tweenProjection = geoProjection((lambda, phi) => {
      const point = morphedProjectedPoint(
        sourceProjection,
        targetProjection,
        [(lambda * 180) / Math.PI, (phi * 180) / Math.PI],
        alpha,
      )

      return [point[0] - origin[0], origin[1] - point[1]]
    })

    tweenProjection
      .scale(1)
      .translate(origin)
      .center([0, 0])
      .rotate([0, 0, 0])
      .precision(0.6)

    return tweenProjection
  }

  function isVisible(view: ProjectionView, coordinates: [number, number]): boolean {
    if (view.mode === 'map') {
      return true
    }

    const [rotationLongitude, rotationLatitude] = view.projection.rotate()
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

  function zoomForCountry(countryId: string, view: ProjectionView): number {
    const angularRadius = angularRadiusForCountry(countryId) ?? MIN_COUNTRY_ANGULAR_RADIUS
    const baseScale = Math.max(view.baseScale, 1)
    const targetZoom = FOCUS_COUNTRY_RADIUS_PX / Math.max(baseScale * angularRadius, 0.0001)
    return clampZoom(targetZoom)
  }

  function mapPanOffsetsForCoordinates(
    coordinates: [number, number],
    zoom: number,
  ): [number, number] | null {
    const previousZoom = mapView.currentZoom
    const previousPanOffsetX = mapView.panOffsetX
    const previousPanOffsetY = mapView.panOffsetY

    mapView.currentZoom = zoom
    mapView.panOffsetX = 0
    mapView.panOffsetY = 0
    syncViewProjection(mapView)
    const projected = mapView.projection(coordinates)

    mapView.currentZoom = previousZoom
    mapView.panOffsetX = previousPanOffsetX
    mapView.panOffsetY = previousPanOffsetY
    syncViewProjection(mapView)

    if (!projected) {
      return null
    }

    return [cssWidth / 2 - projected[0], cssHeight / 2 - projected[1]]
  }

  function mapPanOffsetsForCountry(countryId: string, zoom: number): [number, number] | null {
    const centroid = centroidForCountry(countryId)
    return centroid ? mapPanOffsetsForCoordinates(centroid, zoom) : null
  }

  function centerCoordinatesForView(view: ProjectionView): [number, number] | null {
    if (view.mode === 'globe') {
      const [rotationLongitude, rotationLatitude] = view.projection.rotate()
      return [-rotationLongitude, -rotationLatitude]
    }

    return (view.projection.invert?.([cssWidth / 2, cssHeight / 2]) as [number, number] | null) ?? null
  }

  function alignViewToCoordinates(
    view: ProjectionView,
    coordinates: [number, number],
    zoom = view.currentZoom,
  ): void {
    view.currentZoom = clampZoom(zoom)

    if (view.mode === 'globe') {
      const [rotationLongitude, , rotationGamma] = view.projection.rotate()
      const clampedLatitude = Math.max(-75, Math.min(75, coordinates[1]))
      view.projection.rotate([
        shortestLongitudeTarget(rotationLongitude, -coordinates[0]),
        -clampedLatitude,
        rotationGamma,
      ])
      return
    }

    const targetPanOffsets = mapPanOffsetsForCoordinates(coordinates, view.currentZoom)

    if (targetPanOffsets) {
      view.panOffsetX = targetPanOffsets[0]
      view.panOffsetY = targetPanOffsets[1]
    }
  }

  function focusCountry(view: ProjectionView, countryId: string): void {
    const centroid = centroidForCountry(countryId)

    if (!centroid) {
      return
    }

    alignViewToCoordinates(view, centroid, zoomForCountry(countryId, view))
  }

  function focusCountryAllViews(countryId: string): void {
    for (const view of projectionViews) {
      focusCountry(view, countryId)
    }
  }

  function flightPathGeometry(
    segment: FlightSegment,
    progress = 1,
  ): GeoPermissibleObjects {
    if (progress >= 1) {
      return {
        type: 'LineString',
        coordinates: segment.pathCoordinates,
      } as GeoPermissibleObjects
    }

    const interpolatedCoordinates = geoInterpolate(
      segment.fromCoordinates,
      segment.toCoordinates,
    )(Math.max(0, progress)) as [number, number]
    const lastIndex = segment.pathCoordinates.length - 1
    const visiblePointCount = Math.max(1, Math.floor(lastIndex * Math.max(0, progress)))
    const coordinates = segment.pathCoordinates.slice(0, visiblePointCount + 1)
    const lastCoordinates = coordinates[coordinates.length - 1]

    if (
      !lastCoordinates ||
      lastCoordinates[0] !== interpolatedCoordinates[0] ||
      lastCoordinates[1] !== interpolatedCoordinates[1]
    ) {
      coordinates.push(interpolatedCoordinates)
    }

    return {
      type: 'LineString',
      coordinates,
    } as GeoPermissibleObjects
  }

  function buildFlightSegments(answerOrder: string[]): {
    planePosition: [number, number] | null
    segments: FlightSegment[]
    status: GlobeFlightStatus | null
  } {
    const startCountry = countryById.get(FLIGHT_START_COUNTRY_ID)
    let previousCountryId = FLIGHT_START_COUNTRY_ID
    let previousCoordinates = centroidForCountry(previousCountryId)
    let totalMiles = 0
    const segments: FlightSegment[] = []

    for (const [index, countryId] of answerOrder.entries()) {
      const fromCountry = countryById.get(previousCountryId) ?? startCountry
      const toCountry = countryById.get(countryId)
      const toCoordinates = centroidForCountry(countryId)

      if (!fromCountry || !toCountry || !previousCoordinates || !toCoordinates) {
        previousCountryId = countryId
        previousCoordinates = toCoordinates
        continue
      }

      const miles = toMiles(geoDistance(previousCoordinates, toCoordinates))
      totalMiles += miles
      segments.push({
        fromCoordinates: previousCoordinates,
        fromCountryId: previousCountryId,
        fromName: fromCountry.name,
        id: `${index}-${previousCountryId}-${countryId}`,
        miles,
        pathCoordinates: greatArcCoordinates(previousCoordinates, toCoordinates),
        toCoordinates,
        toCountryId: countryId,
        toName: toCountry.name,
      })
      previousCountryId = countryId
      previousCoordinates = toCoordinates
    }

    const lastSegment = segments.at(-1) ?? null

    return {
      planePosition: previousCoordinates,
      segments,
      status: lastSegment
        ? {
          fromName: lastSegment.fromName,
          legMiles: lastSegment.miles,
          toName: lastSegment.toName,
          totalMiles,
        }
        : null,
    }
  }

  function renderFlights(view: ProjectionView): void {
    const renderedSegments = showDesktopFlightTrails ? flightSegments : []

    view.flightTrailLayer
      .selectAll<SVGPathElement, FlightSegment>('path.globe__flight-trail')
      .data(renderedSegments, (segment) => segment.id)
      .join('path')
      .attr('class', 'globe__flight-trail')
      .attr('d', (segment) => projectedPathData(view, flightPathGeometry(segment)))
      .attr('fill', 'none')
      .attr('stroke', (segment) =>
        segment.id === activeFlightSegmentId
          ? 'rgba(255, 234, 163, 0.24)'
          : 'rgba(255, 226, 120, 0.18)',
      )
      .attr('stroke-width', (segment) => (segment.id === activeFlightSegmentId ? 1.35 : 1.1))
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round')
      .attr('stroke-dasharray', (segment) =>
        segment.id === activeFlightSegmentId ? '4.5 7.5' : '3.2 8.2',
      )

    const activeSegment = showDesktopFlightTrails
      ? flightSegments.find((segment) => segment.id === activeFlightSegmentId) ?? null
      : null

    view.flightActiveLayer
      .selectAll<SVGPathElement, FlightSegment>('path.globe__flight-progress')
      .data(activeSegment ? [activeSegment] : [], (segment) => segment.id)
      .join('path')
      .attr('class', 'globe__flight-progress')
      .attr('d', (segment) => projectedPathData(view, flightPathGeometry(segment, activeFlightProgress)))
      .attr('fill', 'none')
      .attr('stroke', 'rgba(255, 239, 187, 0.68)')
      .attr('stroke-width', 2)
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round')
  }

  function projectedLabelPosition(view: ProjectionView, countryId: string): [number, number] | null {
    const centroid = centroidForCountry(countryId)
    const labelFeature = labelFeatureForCountry(countryId)

    if (!centroid || !labelFeature || !isVisible(view, centroid)) {
      return null
    }

    const projected = view.measurementPath.centroid(labelFeature)

    if (!projected || Number.isNaN(projected[0]) || Number.isNaN(projected[1])) {
      return null
    }

    return [projected[0], projected[1]]
  }

  function projectedPlaneLabelAnchor(
    view: ProjectionView,
    countryId: string,
  ): [number, number] | null {
    const projectedLabel = projectedLabelPosition(view, countryId)

    if (!projectedLabel) {
      return null
    }

    return [projectedLabel[0], projectedLabel[1] + PLANE_LABEL_OFFSET_PX]
  }

  function correctedProjectedPlanePosition(
    view: ProjectionView,
    segment: FlightSegment,
    progress: number,
  ): [number, number] | null {
    const projectedFlightPoint = view.projection(
      geoInterpolate(segment.fromCoordinates, segment.toCoordinates)(progress) as [number, number],
    )

    if (!projectedFlightPoint) {
      return null
    }

    const projectedStart = view.projection(segment.fromCoordinates)
    const projectedEnd = view.projection(segment.toCoordinates)
    const startAnchor = projectedPlaneLabelAnchor(view, segment.fromCountryId)
    const endAnchor = projectedPlaneLabelAnchor(view, segment.toCountryId)

    if (!projectedStart || !projectedEnd || !startAnchor || !endAnchor) {
      return [projectedFlightPoint[0], projectedFlightPoint[1]]
    }

    const startDx = startAnchor[0] - projectedStart[0]
    const startDy = startAnchor[1] - projectedStart[1]
    const endDx = endAnchor[0] - projectedEnd[0]
    const endDy = endAnchor[1] - projectedEnd[1]

    return [
      projectedFlightPoint[0] + interpolateNumber(startDx, endDx, progress),
      projectedFlightPoint[1] + interpolateNumber(startDy, endDy, progress),
    ]
  }

  function planeHeadingDegrees(
    view: ProjectionView,
    segment: FlightSegment,
    progress: number,
  ): number {
    const startProgress = Math.max(0, Math.min(1, progress - PLANE_TANGENT_SAMPLE_STEP))
    const endProgress = Math.max(0, Math.min(1, progress + PLANE_TANGENT_SAMPLE_STEP))

    if (Math.abs(endProgress - startProgress) < 0.0001) {
      return 0
    }

    const interpolateCoordinates = geoInterpolate(
      segment.fromCoordinates,
      segment.toCoordinates,
    )
    const startPoint = view.projection(interpolateCoordinates(startProgress) as [number, number])
    const endPoint = view.projection(interpolateCoordinates(endProgress) as [number, number])

    if (!startPoint || !endPoint) {
      return 0
    }

    return (
      (Math.atan2(endPoint[1] - startPoint[1], endPoint[0] - startPoint[0]) * 180) / Math.PI -
      PLANE_EMOJI_BASE_HEADING_DEGREES
    )
  }

  function renderLabels(view: ProjectionView): void {
    const visibleLabels = [...answeredIds]
      .map((countryId) => {
        const country = countryById.get(countryId)
        const centroid = centroidForCountry(countryId)
        const labelFeature = labelFeatureForCountry(countryId)

        if (!country || !centroid || !labelFeature || !isVisible(view, centroid)) {
          return null
        }

        const projected = view.measurementPath.centroid(labelFeature)

        if (!projected || Number.isNaN(projected[0]) || Number.isNaN(projected[1])) {
          return null
        }

        return {
          flagAssetUrl: country.appearance.kind === 'flag' ? country.appearance.assetUrl : null,
          id: country.id,
          name: country.name,
          x: projected[0],
          y: projected[1],
        }
      })
      .filter((label): label is GlobeLabel => Boolean(label))

    view.labelLayer
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
                .append('image')
                .attr('class', 'globe__label-flag-image')
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
          .select<SVGImageElement>('.globe__label-flag-image')
          .attr('href', label.flagAssetUrl ?? '')
          .attr('x', -MAP_LABEL_FLAG_WIDTH_PX / 2)
          .attr('y', MAP_LABEL_FLAG_OFFSET_PX - MAP_LABEL_FLAG_HEIGHT_PX / 2)
          .attr('width', MAP_LABEL_FLAG_WIDTH_PX)
          .attr('height', MAP_LABEL_FLAG_HEIGHT_PX)
          .attr('preserveAspectRatio', 'xMidYMid meet')
          .attr('display', label.flagAssetUrl ? null : 'none')
      })
  }

  function renderPlane(view: ProjectionView, mostRecentAnsweredId: string | null): void {
    const activeSegment = flightSegments.find((segment) => segment.id === activeFlightSegmentId) ?? null
    const latestSegment = flightSegments.at(-1) ?? null

    let anchorPoint: [number, number] | null = null
    let localOffsetY = 0
    let headingDegrees = latestSegment ? planeHeadingDegrees(view, latestSegment, 1) : 0

    if (activeSegment && planeCoordinates && isVisible(view, planeCoordinates)) {
      anchorPoint = correctedProjectedPlanePosition(view, activeSegment, activeFlightProgress)
      headingDegrees = planeHeadingDegrees(view, activeSegment, activeFlightProgress)
    } else if (mostRecentAnsweredId) {
      anchorPoint = projectedPlaneLabelAnchor(view, mostRecentAnsweredId)
    } else if (planeCoordinates && isVisible(view, planeCoordinates)) {
      const projected = view.projection(planeCoordinates)

      if (projected) {
        anchorPoint = [projected[0], projected[1]]
      }
    }

    if (!anchorPoint) {
      view.planeLayer.attr('display', 'none')
      return
    }

    view.planeLayer.attr('display', null)
    view.planeMarker
      .attr('transform', `translate(${anchorPoint[0]} ${anchorPoint[1]})`)
      .attr('data-moving', activeFlightSegmentId && activeFlightProgress < 1 ? 'true' : 'false')

    view.planeMarker
      .select<SVGCircleElement>('.globe__plane-halo')
      .attr('cx', 0)
      .attr('cy', localOffsetY)
      .attr('r', activeFlightSegmentId && activeFlightProgress < 1 ? 15 : 12)

    view.planeMarker
      .select<SVGTextElement>('.globe__plane-emoji')
      .attr('x', 0)
      .attr('y', localOffsetY)
      .attr('transform', `rotate(${headingDegrees} 0 ${localOffsetY})`)
  }

  function renderView(view: ProjectionView): void {
    const mostRecentAnsweredId = latestAnsweredId(answeredIds)
    const spherePathData = projectedPathData(view, sphere)
    const seaOpacity = seaVisibility()

    view.clipOutlinePath.attr('d', spherePathData)

    view.spherePath
      .attr('d', spherePathData)
      .attr('fill', SEA_FILL)
      .attr(
        'stroke',
        view.mode === 'globe' ? 'rgba(180, 225, 255, 0.55)' : 'rgba(180, 225, 255, 0.34)',
      )
      .attr('stroke-width', view.mode === 'globe' ? 2.2 : 1.35)
      .style('opacity', seaOpacity.toFixed(3))

    view.graticulePath
      .attr('d', projectedPathData(view, graticule))
      .attr('fill', 'none')
      .attr('stroke', 'rgba(168, 212, 244, 0.2)')
      .attr('stroke-width', 0.7)

    view.countriesLayer
      .selectAll<SVGPathElement, GeoPermissibleObjects>('path')
      .data([atlas.landFeature])
      .join('path')
      .attr('d', (featureEntry) => projectedPathData(view, featureEntry))
      .attr('fill', UNSOLVED_LAND_FILL)
      .attr('stroke', 'none')

    view.fallbackLayer
      .selectAll<SVGPathElement, AtlasFeature>('path')
      .data([])
      .join('path')
      .attr('d', (fallbackFeature) => projectedPathData(view, fallbackFeature))
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

        if (solvedCentroid && !isVisible(view, solvedCentroid)) {
          return null
        }

        return {
          appearanceFill:
            cheatedIds.has(countryId)
              ? CHEATED_SOLVED_FILL
              : countryId === mostRecentAnsweredId
                ? LATEST_SOLVED_FILL
                : appearanceFill(country.appearance),
          feature: countryFeature,
          id: countryId,
        }
      })
      .filter((entry): entry is { appearanceFill: string; feature: AtlasFeature; id: string } => Boolean(entry))

    view.solvedLayer
      .selectAll<SVGPathElement, { appearanceFill: string; feature: AtlasFeature; id: string }>('path')
      .data(visibleSolvedFeatures, (entry) => entry.id)
      .join('path')
      .attr('d', (entry) => projectedPathData(view, entry.feature))
      .attr('fill', (entry) => entry.appearanceFill)
      .attr('stroke', SOLVED_COUNTRY_OUTLINE_COLOR)
      .attr('stroke-width', SOLVED_COUNTRY_OUTLINE_WIDTH)
      .attr('stroke-linejoin', 'round')
      .attr('stroke-linecap', 'round')

    renderFlights(view)

    view.coastlinePath
      .attr('d', projectedPathData(view, atlas.landFeature))
      .attr('fill', 'none')
      .attr('stroke', 'rgba(239, 247, 255, 0.76)')
      .attr('stroke-width', 1.3)
      .attr('stroke-linejoin', 'round')
      .attr('stroke-linecap', 'round')

    view.borderPath
      .attr('d', projectedPathData(view, atlas.borderMesh))
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

    view.fallbackOutlineLayer
      .selectAll<SVGPathElement, { answered: boolean; feature: AtlasFeature; id: string }>('path')
      .data(fallbackOutlineData, (entry) => entry.id)
      .join('path')
      .attr('d', (entry) => projectedPathData(view, entry.feature))
      .attr('fill', 'none')
      .attr('stroke', (entry) =>
        entry.answered
          ? 'rgba(125, 80, 0, 0.9)'
          : 'rgba(227, 238, 247, 0.7)',
      )
      .attr('stroke-width', (entry) => (entry.answered ? 0.85 : 0.95))

    const hitTargetData = countries
      .map((country) => {
        const feature = featureForCountry(country.id)

        if (!feature) {
          return null
        }

        return {
          feature,
          id: country.id,
        }
      })
      .filter((entry): entry is { feature: AtlasFeature; id: string } => Boolean(entry))

    view.hitTargetLayer
      .selectAll<SVGPathElement, { feature: AtlasFeature; id: string }>('path')
      .data(hitTargetData, (entry) => entry.id)
      .join('path')
      .attr('class', 'globe__hit-target')
      .attr('data-country-id', (entry) => entry.id)
      .attr('d', (entry) => projectedPathData(view, entry.feature))
      .attr('fill', 'rgba(0, 0, 0, 0.001)')
      .attr('stroke', 'none')
      .on('click', function (event: MouseEvent, entry) {
        if (!event.shiftKey) {
          return
        }

        event.preventDefault()
        options?.onCountryCheat?.(entry.id)
      })

    renderLabels(view)
    renderPlane(view, mostRecentAnsweredId)
  }

  function renderNow(): void {
    for (const view of projectionViews) {
      syncViewProjection(view)
      renderView(view)
    }

    if (projectionTransitionActive) {
      renderView(transitionView)
      transitionView.labelsRoot.attr('display', 'none')
      transitionView.hitTargetLayer.selectAll('*').remove()
      transitionView.planeLayer.attr('display', 'none')
    }

    updateViewVisibility()
    writeRenderState()
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

  function settleActiveFlight(): void {
    if (!activeFlightSegmentId) {
      return
    }

    const activeSegment = flightSegments.find((segment) => segment.id === activeFlightSegmentId)

    if (activeSegment) {
      planeCoordinates = activeSegment.toCoordinates
    }

    activeFlightSegmentId = null
    activeFlightProgress = 1
  }

  function cancelFlyAnimation(): void {
    if (flyFrame !== null) {
      window.cancelAnimationFrame(flyFrame)
      flyFrame = null
    }

    settleActiveFlight()
  }

  function applyZoom(nextZoom: number): void {
    currentView().currentZoom = clampZoom(nextZoom)
    scheduleRender()
  }

  function clearTouchCheatState(): void {
    if (!touchCheatState) {
      return
    }

    window.clearTimeout(touchCheatState.timeoutId)
    touchCheatState = null
  }

  function startTouchCheat(countryId: string, touch: Touch): void {
    clearTouchCheatState()
    touchCheatState = {
      countryId,
      startX: touch.clientX,
      startY: touch.clientY,
      timeoutId: window.setTimeout(() => {
        const activeCountryId = touchCheatState?.countryId ?? null
        touchCheatState = null

        if (activeCountryId) {
          options?.onCountryCheat?.(activeCountryId)
        }
      }, MOBILE_CHEAT_HOLD_MS),
    }
  }

  function maintainTouchCheat(touch: Touch): void {
    if (!touchCheatState) {
      return
    }

    if (
      touch.clientX !== touchCheatState.startX ||
      touch.clientY !== touchCheatState.startY
    ) {
      clearTouchCheatState()
    }
  }

  function wheelZoomFactor(event: WheelEvent): number {
    const modeScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 18 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 120 : 1
    const clampedDelta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, event.deltaY * modeScale))
    return Math.exp(-clampedDelta * WHEEL_ZOOM_SENSITIVITY)
  }

  function animateFlight(segment: FlightSegment): void {
    cancelFlyAnimation()

    const animatedView = currentView()
    const inactiveViews = projectionViews.filter((view) => view !== animatedView)

    for (const inactiveView of inactiveViews) {
      focusCountry(inactiveView, segment.toCountryId)
    }

    const startTime = performance.now()
    const interpolatePlaneCoordinates = geoInterpolate(
      segment.fromCoordinates,
      segment.toCoordinates,
    )

    activeFlightSegmentId = segment.id
    activeFlightProgress = 0
    planeCoordinates = segment.fromCoordinates

    const startZoom = animatedView.currentZoom
    const targetZoom = zoomForCountry(segment.toCountryId, animatedView)

    let startLongitude = 0
    let startLatitude = 0
    let startGamma = 0
    let targetLongitude = 0
    let targetLatitude = 0
    let startPanOffsetX = 0
    let startPanOffsetY = 0
    let targetPanOffsetX = 0
    let targetPanOffsetY = 0

    if (animatedView.mode === 'globe') {
      ;[startLongitude, startLatitude, startGamma] = animatedView.projection.rotate()
      targetLongitude = shortestLongitudeTarget(startLongitude, -segment.toCoordinates[0])
      targetLatitude = -segment.toCoordinates[1]
    } else {
      startPanOffsetX = animatedView.panOffsetX
      startPanOffsetY = animatedView.panOffsetY
      const targetPanOffsets = mapPanOffsetsForCountry(segment.toCountryId, targetZoom)
      targetPanOffsetX = targetPanOffsets?.[0] ?? startPanOffsetX
      targetPanOffsetY = targetPanOffsets?.[1] ?? startPanOffsetY
    }

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startTime) / FLY_DURATION_MS)
      const eased = easeInOutCubic(progress)

      animatedView.currentZoom = clampZoom(interpolateNumber(startZoom, targetZoom, eased))

      if (animatedView.mode === 'globe') {
        animatedView.projection.rotate([
          interpolateNumber(startLongitude, targetLongitude, eased),
          interpolateNumber(startLatitude, targetLatitude, eased),
          startGamma,
        ])
      } else {
        animatedView.panOffsetX = interpolateNumber(startPanOffsetX, targetPanOffsetX, eased)
        animatedView.panOffsetY = interpolateNumber(startPanOffsetY, targetPanOffsetY, eased)
      }

      activeFlightProgress = eased
      planeCoordinates = interpolatePlaneCoordinates(eased) as [number, number]
      renderNow()

      if (progress < 1) {
        flyFrame = window.requestAnimationFrame(tick)
        return
      }

      planeCoordinates = segment.toCoordinates
      activeFlightProgress = 1
      activeFlightSegmentId = null
      flyFrame = null
      focusCountryAllViews(segment.toCountryId)
      renderNow()
    }

    flyFrame = window.requestAnimationFrame(tick)
  }

  planeCoordinates = centroidForCountry(FLIGHT_START_COUNTRY_ID)
  updateViewVisibility()
  desktopFlightTrailsMediaQuery.addEventListener('change', (event) => {
    showDesktopFlightTrails = event.matches
    scheduleRender()
  })

  const resizeObserver = new ResizeObserver(() => {
    syncCanvasSize()
  })
  resizeObserver.observe(container)
  syncCanvasSize()

  const dragBehavior = drag<SVGSVGElement, unknown>()
    .filter((event: MouseEvent | TouchEvent) => {
      if (projectionTransitionActive) {
        return false
      }

      if (event instanceof TouchEvent) {
        return event.touches.length <= 1
      }

      return !event.ctrlKey && event.button === 0
    })
    .on('start', () => {
      cancelFlyAnimation()
    })
    .on('drag', (event: D3DragEvent<SVGSVGElement, unknown, unknown>) => {
      const activeView = currentView()

      if (activeView.mode === 'globe') {
        const [rotationLongitude, rotationLatitude, rotationGamma] = activeView.projection.rotate()
        const sensitivity = 72 / Math.max(currentScale(activeView), 1)
        const nextLatitude = Math.max(-75, Math.min(75, rotationLatitude - event.dy * sensitivity))

        activeView.projection.rotate([
          rotationLongitude + event.dx * sensitivity,
          nextLatitude,
          rotationGamma,
        ])
      } else {
        activeView.panOffsetX += event.dx
        activeView.panOffsetY += event.dy
      }

      scheduleRender()
    })

  mapSvg.call(dragBehavior)

  const mapSvgNode = mapSvg.node()

  if (!mapSvgNode) {
    throw new Error('Map SVG could not be created')
  }

  const countryIdFromTouchTarget = (target: EventTarget | null): string | null => {
    if (!(target instanceof Element)) {
      return null
    }

    const hitTarget = target.closest('.globe__hit-target[data-country-id]')

    if (!(hitTarget instanceof SVGPathElement)) {
      return null
    }

    return hitTarget.dataset.countryId ?? null
  }

  mapSvgNode.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      if (projectionTransitionActive) {
        return
      }

      event.preventDefault()
      cancelFlyAnimation()
      applyZoom(currentView().currentZoom * wheelZoomFactor(event))
    },
    { passive: false },
  )

  mapSvgNode.addEventListener(
    'touchstart',
    (event: TouchEvent) => {
      if (projectionTransitionActive) {
        return
      }

      const targetCountryId = countryIdFromTouchTarget(event.target)

      if (event.touches.length === 1 && targetCountryId) {
        startTouchCheat(targetCountryId, event.touches[0])
        pinchZoomState = null
        return
      }

      clearTouchCheatState()

      if (event.touches.length !== 2) {
        pinchZoomState = null
        return
      }

      const [firstTouch, secondTouch] = [event.touches[0], event.touches[1]]
      const distance = distanceBetweenTouches(firstTouch, secondTouch)

      if (distance < MIN_PINCH_DISTANCE_PX) {
        pinchZoomState = null
        return
      }

      event.preventDefault()
      cancelFlyAnimation()
      pinchZoomState = {
        distance,
        zoom: currentView().currentZoom,
      }
    },
    { capture: true, passive: false },
  )

  mapSvgNode.addEventListener(
    'touchmove',
    (event: TouchEvent) => {
      if (projectionTransitionActive) {
        return
      }

      if (event.touches.length === 1) {
        maintainTouchCheat(event.touches[0])
        pinchZoomState = null
        return
      }

      clearTouchCheatState()

      if (event.touches.length !== 2) {
        return
      }

      const [firstTouch, secondTouch] = [event.touches[0], event.touches[1]]
      const distance = distanceBetweenTouches(firstTouch, secondTouch)

      if (distance < MIN_PINCH_DISTANCE_PX) {
        return
      }

      if (!pinchZoomState) {
        pinchZoomState = {
          distance,
          zoom: currentView().currentZoom,
        }
      }

      event.preventDefault()
      event.stopImmediatePropagation()
      applyZoom(pinchZoomState.zoom * (distance / pinchZoomState.distance))
    },
    { capture: true, passive: false },
  )

  const clearPinchZoomState = (): void => {
    pinchZoomState = null
  }

  mapSvgNode.addEventListener(
    'touchend',
    () => {
      clearPinchZoomState()
      clearTouchCheatState()
    },
    { capture: true },
  )
  mapSvgNode.addEventListener(
    'touchcancel',
    () => {
      clearPinchZoomState()
      clearTouchCheatState()
    },
    { capture: true },
  )

  return {
    setAnswered(nextAnsweredIds: Set<string>, options) {
      answeredIds = new Set(nextAnsweredIds)
      cheatedIds = new Set(options?.cheatedIds ?? [])

      if (options?.focusLatest) {
        const mostRecentAnsweredId = latestAnsweredId(answeredIds)

        if (mostRecentAnsweredId) {
          cancelFlyAnimation()
          focusCountryAllViews(mostRecentAnsweredId)
        }
      }

      scheduleRender()
    },
    syncFlightPath(answerOrder: string[], options) {
      const previousLastSegmentId = flightSegments.at(-1)?.id ?? null
      const nextFlightState = buildFlightSegments(answerOrder)
      const lastSegment = nextFlightState.segments.at(-1) ?? null

      cancelFlyAnimation()
      flightSegments = nextFlightState.segments
      planeCoordinates =
        nextFlightState.planePosition ?? centroidForCountry(FLIGHT_START_COUNTRY_ID)

      if (!lastSegment) {
        scheduleRender()
        return null
      }

      if (options?.animate && lastSegment.id !== previousLastSegmentId) {
        animateFlight(lastSegment)
        return nextFlightState.status
      }

      focusCountryAllViews(lastSegment.toCountryId)
      scheduleRender()
      return nextFlightState.status
    },
    setProjectionMode(mode: ProjectionMode) {
      if (mode === activeMode || projectionTransitionActive) {
        return
      }

      cancelFlyAnimation()
      clearTouchCheatState()
      pinchZoomState = null

      const sourceView = currentView()
      const targetView = viewByMode[mode]
      const sourceCenter = centerCoordinatesForView(sourceView)

      projectionTransitionActive = true
      projectionTransitionProgress = 0
      projectionTransitionSourceMode = activeMode
      projectionTransitionTargetMode = mode

      if (sourceCenter) {
        alignViewToCoordinates(targetView, sourceCenter, sourceView.currentZoom)
      } else {
        targetView.currentZoom = clampZoom(sourceView.currentZoom)
      }

      syncViewProjection(sourceView)
      syncViewProjection(targetView)
      const sourceProjection = cloneProjection(sourceView)
      const targetProjection = cloneProjection(targetView)

      if (sourceView.mode === 'globe') {
        sourceProjection.clipAngle(179.999)
      }

      if (targetView.mode === 'globe') {
        targetProjection.clipAngle(179.999)
      }

      updateViewVisibility()
      transitionView.projection = createProjectionTweenProjection(
        sourceProjection,
        targetProjection,
        0,
      )
      transitionView.mode = 'map'
      transitionView.measurementPath = geoPath(transitionView.projection)
      renderNow()

      const finishTransition = (): void => {
        projectionTransitionActive = false
        projectionTransitionProgress = 1
        projectionTransitionSourceMode = null
        projectionTransitionTargetMode = null
        activeMode = mode
        updateViewVisibility()
        scheduleRender()
      }

      select(container)
        .interrupt('projection-morph')
        .transition('projection-morph')
        .duration(PROJECTION_TRANSITION_DURATION_MS)
        .ease(easeCubicInOut)
        .tween('projection-morph', () => {
          return (t: number) => {
            projectionTransitionProgress = t
            transitionView.projection = createProjectionTweenProjection(
              sourceProjection,
              targetProjection,
              t,
            )
            transitionView.measurementPath = geoPath(transitionView.projection)
            renderNow()
          }
        })
        .on('end', finishTransition)
        .on('interrupt', finishTransition)
    },
    zoomBy(factor: number) {
      cancelFlyAnimation()
      applyZoom(currentView().currentZoom * factor)
    },
  }
}
