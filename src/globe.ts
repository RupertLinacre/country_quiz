import {
  type D3DragEvent,
  type EnterElement,
  type GeoPermissibleObjects,
  type Selection,
  drag,
  geoCentroid,
  geoDistance,
  geoGraticule10,
  geoOrthographic,
  geoPath,
  select,
} from 'd3'
import { feature, mesh } from 'topojson-client'
import atlasUrl from 'world-atlas/countries-10m.json?url'

import type { QuizCountry, SolvedAppearance } from './quiz-data'

type AtlasFeature = GeoPermissibleObjects & {
  id?: string | number
  properties?: {
    name?: string
  }
}

type GlobeController = {
  setAnswered: (answeredIds: Set<string>) => void
  zoomBy: (factor: number) => void
}

type GlobeLabel = {
  id: string
  name: string
  x: number
  y: number
}

const VIEWBOX_SIZE = 760
const BASE_SCALE = 242
const MIN_SCALE = 190
const MAX_SCALE = 420

function appearanceFill(appearance: SolvedAppearance): string {
  if (appearance.kind === 'flag') {
    return appearance.fallbackFill
  }

  return appearance.fill
}

function normaliseAtlasId(value: string | number | undefined): string | null {
  if (value === undefined) {
    return null
  }

  return String(value).padStart(3, '0')
}

export async function createGlobe(
  container: HTMLElement,
  countries: QuizCountry[],
): Promise<GlobeController> {
  const topology = (await fetch(atlasUrl).then((response) => response.json())) as {
    objects: {
      countries: object
      land: object
    }
  }
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
  const countryByFeature = new Map<AtlasFeature, QuizCountry>()

  for (const country of countries) {
    const matchedFeature =
      (country.ccn3 ? byCcn3.get(country.ccn3.padStart(3, '0')) : undefined) ??
      byName.get(country.atlasName)

    if (!matchedFeature) {
      continue
    }

    featureByCountryId.set(country.id, matchedFeature)
    countryByFeature.set(matchedFeature, country)
  }

  const projection = geoOrthographic()
    .translate([VIEWBOX_SIZE / 2, VIEWBOX_SIZE / 2])
    .scale(BASE_SCALE)
    .clipAngle(90)
    .precision(0.3)
    .rotate([-12, -18])
  const path = geoPath(projection)
  const graticule = geoGraticule10()
  const sphere = { type: 'Sphere' } as GeoPermissibleObjects

  const svg = select(container)
    .append('svg')
    .attr('class', 'globe__svg')
    .attr('viewBox', `0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`)
    .attr('role', 'img')
    .attr('aria-label', 'Interactive globe showing countries of the world')

  const defs = svg.append('defs')
  defs
    .append('clipPath')
    .attr('id', 'globe-clip')
    .append('path')
    .attr('class', 'globe__clip')

  const sphereLayer = svg.append('g').attr('class', 'globe__sphere')
  const mapLayer = svg.append('g').attr('clip-path', 'url(#globe-clip)')
  const labelLayer = svg.append('g').attr('class', 'globe__labels').attr('clip-path', 'url(#globe-clip)')

  const spherePath = sphereLayer.append('path').attr('class', 'globe__water')
  const glowPath = sphereLayer.append('path').attr('class', 'globe__rim')
  const graticulePath = mapLayer.append('path').attr('class', 'globe__graticule')
  const landPath = mapLayer.append('path').attr('class', 'globe__land')
  const countriesSelection = mapLayer
    .selectAll<SVGPathElement, AtlasFeature>('path.globe__country')
    .data(countryFeatures)
    .join('path')
    .attr('class', 'globe__country')
  const bordersPath = mapLayer.append('path').attr('class', 'globe__borders')

  let currentScale = BASE_SCALE
  let answeredIds = new Set<string>()

  function isVisible(coordinates: [number, number]): boolean {
    const [rotationLongitude, rotationLatitude] = projection.rotate()
    const center: [number, number] = [-rotationLongitude, -rotationLatitude]
    return geoDistance(center, coordinates) < Math.PI / 2 - 0.05
  }

  function renderLabels(): void {
    const visibleLabels = countries
      .filter((country) => answeredIds.has(country.id))
      .map((country) => {
        const countryFeature = featureByCountryId.get(country.id)

        if (!countryFeature) {
          return null
        }

        const centroid = geoCentroid(countryFeature)

        if (!isVisible(centroid)) {
          return null
        }

        const projected = projection(centroid)

        if (!projected) {
          return null
        }

        return {
          id: country.id,
          name: country.name,
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
          enter
            .append('text')
            .attr('class', 'globe__label')
            .attr('text-anchor', 'middle')
            .attr('dy', '0.35em')
            .text((label: GlobeLabel) => label.name),
        (update: Selection<SVGTextElement, GlobeLabel, SVGGElement, unknown>) => update,
        (exit: Selection<SVGTextElement, GlobeLabel, SVGGElement, unknown>) => exit.remove(),
      )
      .attr('x', (label: GlobeLabel) => label.x)
      .attr('y', (label: GlobeLabel) => label.y)
  }

  function render(): void {
    projection.scale(currentScale)

    defs.select<SVGPathElement>('path.globe__clip').attr('d', path(sphere))
    spherePath.attr('d', path(sphere))
    glowPath.attr('d', path(sphere))
    graticulePath.attr('d', path(graticule))
    landPath.attr('d', path(landFeature))
    bordersPath.attr('d', path(borderMesh))

    countriesSelection
      .attr('d', (countryFeature: AtlasFeature) => path(countryFeature))
      .attr('data-country-name', (countryFeature: AtlasFeature) => countryByFeature.get(countryFeature)?.name ?? '')
      .classed('globe__country--answered', (countryFeature: AtlasFeature) => {
        const country = countryByFeature.get(countryFeature)
        return Boolean(country && answeredIds.has(country.id))
      })
      .attr('fill', (countryFeature: AtlasFeature) => {
        const country = countryByFeature.get(countryFeature)

        if (!country || !answeredIds.has(country.id)) {
          return '#1a4466'
        }

        return appearanceFill(country.appearance)
      })

    renderLabels()
  }

  function applyScale(nextScale: number): void {
    currentScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale))
    render()
  }

  svg.call(
    drag<SVGSVGElement, unknown>().on('drag', (event: D3DragEvent<SVGSVGElement, unknown, unknown>) => {
        const [rotationLongitude, rotationLatitude, rotationGamma] = projection.rotate()
        const sensitivity = 72 / currentScale
        const nextLatitude = Math.max(-75, Math.min(75, rotationLatitude - event.dy * sensitivity))

        projection.rotate([
          rotationLongitude + event.dx * sensitivity,
          nextLatitude,
          rotationGamma,
        ])
        render()
      }),
  )

  svg.node()?.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      event.preventDefault()
      const factor = event.deltaY < 0 ? 1.08 : 0.92
      applyScale(currentScale * factor)
    },
    { passive: false },
  )

  render()

  return {
    setAnswered(nextAnsweredIds: Set<string>) {
      answeredIds = new Set(nextAnsweredIds)
      render()
    },
    zoomBy(factor: number) {
      applyScale(currentScale * factor)
    },
  }
}
