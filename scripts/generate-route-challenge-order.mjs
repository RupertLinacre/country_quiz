import fs from 'node:fs/promises'
import path from 'node:path'

import { geoArea, geoCentroid, geoDistance } from 'd3'
import { feature } from 'topojson-client'

import fallbackFeatures from '../src/generated/country-geometry-fallbacks.json' with { type: 'json' }
import topology from '../src/generated/globe-atlas.json' with { type: 'json' }
import countries from '../src/generated/quiz-country-records.json' with { type: 'json' }

const START_COUNTRY_ID = 'GBR'
const EARTH_RADIUS_MILES = 3958.7613
const ITERATION_COUNT = 96
const MAX_NEAREST_NEIGHBOR_BREADTH = 6
const MAX_INITIAL_SEED_CHOICES = 8
const MIN_COUNTRY_ANGULAR_RADIUS = 0.0025
const MAX_COUNTRY_POLYGON_AREA = Math.PI * 2
const RNG_SEED = 0x5f3759df

function normaliseAtlasId(value) {
  if (value === undefined || value === null) {
    return null
  }

  return String(value).padStart(3, '0')
}

function normalisePolygonCoordinates(coordinates) {
  const polygon = {
    type: 'Polygon',
    coordinates,
  }

  if (geoArea(polygon) <= MAX_COUNTRY_POLYGON_AREA) {
    return coordinates
  }

  return coordinates.map((ring) => [...ring].reverse())
}

function normaliseCountryFeature(featureEntry) {
  if (!featureEntry.geometry) {
    return featureEntry
  }

  if (featureEntry.geometry.type === 'Polygon') {
    return {
      ...featureEntry,
      geometry: {
        ...featureEntry.geometry,
        coordinates: normalisePolygonCoordinates(featureEntry.geometry.coordinates),
      },
    }
  }

  if (featureEntry.geometry.type === 'MultiPolygon') {
    return {
      ...featureEntry,
      geometry: {
        ...featureEntry.geometry,
        coordinates: featureEntry.geometry.coordinates.map((polygonCoordinates) =>
          normalisePolygonCoordinates(polygonCoordinates),
        ),
      },
    }
  }

  return featureEntry
}

function primaryLabelFeature(featureEntry) {
  const geometry = featureEntry.geometry ?? featureEntry

  if (geometry.type === 'Polygon') {
    return geometry
  }

  if (geometry.type !== 'MultiPolygon') {
    return geometry
  }

  let largestPolygon = geometry.coordinates[0]
  let largestArea = 0

  for (const polygonCoordinates of geometry.coordinates) {
    const polygon = {
      type: 'Polygon',
      coordinates: polygonCoordinates,
    }
    const area = geoArea(polygon)

    if (area > largestArea) {
      largestArea = area
      largestPolygon = polygonCoordinates
    }
  }

  return {
    type: 'Polygon',
    coordinates: largestPolygon,
  }
}

function createSeededRandom(seed) {
  let state = seed >>> 0

  return () => {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function routeDistance(route, distanceBetween) {
  let total = 0

  for (let index = 1; index < route.length; index += 1) {
    total += distanceBetween(route[index - 1], route[index])
  }

  return total
}

function buildNearestNeighborRoute(countryIds, distanceBetween, random) {
  const remaining = countryIds.filter((countryId) => countryId !== START_COUNTRY_ID)
  const route = [START_COUNTRY_ID]
  let currentCountryId = START_COUNTRY_ID

  while (remaining.length > 0) {
    const rankedCandidates = remaining
      .map((countryId, index) => ({
        countryId,
        distance: distanceBetween(currentCountryId, countryId),
        index,
      }))
      .sort((left, right) => left.distance - right.distance)

    const breadth = Math.min(MAX_NEAREST_NEIGHBOR_BREADTH, rankedCandidates.length)
    const pickIndex = Math.floor(random() ** 2 * breadth)
    const nextCandidate = rankedCandidates[pickIndex]

    remaining.splice(nextCandidate.index, 1)
    route.push(nextCandidate.countryId)
    currentCountryId = nextCandidate.countryId
  }

  return route
}

function buildCheapestInsertionRoute(countryIds, distanceBetween, random) {
  const remaining = countryIds.filter((countryId) => countryId !== START_COUNTRY_ID)
  const rankedByStartDistance = remaining
    .slice()
    .sort((left, right) => distanceBetween(START_COUNTRY_ID, left) - distanceBetween(START_COUNTRY_ID, right))
  const initialChoiceIndex = Math.floor(random() * Math.min(MAX_INITIAL_SEED_CHOICES, rankedByStartDistance.length))
  const firstStopId = rankedByStartDistance[initialChoiceIndex]
  const route = [START_COUNTRY_ID, firstStopId]

  remaining.splice(remaining.indexOf(firstStopId), 1)

  while (remaining.length > 0) {
    let bestMove = null

    for (const countryId of remaining) {
      for (let insertIndex = 1; insertIndex <= route.length; insertIndex += 1) {
        const previousCountryId = route[insertIndex - 1]
        const nextCountryId = route[insertIndex] ?? null
        const delta =
          nextCountryId === null
            ? distanceBetween(previousCountryId, countryId)
            : distanceBetween(previousCountryId, countryId) +
              distanceBetween(countryId, nextCountryId) -
              distanceBetween(previousCountryId, nextCountryId)

        if (!bestMove || delta < bestMove.delta) {
          bestMove = {
            countryId,
            delta,
            insertIndex,
          }
        }
      }
    }

    route.splice(bestMove.insertIndex, 0, bestMove.countryId)
    remaining.splice(remaining.indexOf(bestMove.countryId), 1)
  }

  return route
}

function applyTwoOpt(route, distanceBetween) {
  let improved = true

  while (improved) {
    improved = false

    for (let startIndex = 1; startIndex < route.length - 2; startIndex += 1) {
      for (let endIndex = startIndex + 1; endIndex < route.length - 1; endIndex += 1) {
        const beforeLeft = route[startIndex - 1]
        const left = route[startIndex]
        const right = route[endIndex]
        const afterRight = route[endIndex + 1]
        const delta =
          distanceBetween(beforeLeft, right) +
          distanceBetween(left, afterRight) -
          distanceBetween(beforeLeft, left) -
          distanceBetween(right, afterRight)

        if (delta >= -1e-12) {
          continue
        }

        route.splice(
          startIndex,
          endIndex - startIndex + 1,
          ...route.slice(startIndex, endIndex + 1).reverse(),
        )
        improved = true
        break
      }
    }
  }

  return route
}

function applyRelocate(route, distanceBetween) {
  let improved = true

  while (improved) {
    improved = false

    for (let sourceIndex = 1; sourceIndex < route.length; sourceIndex += 1) {
      const countryId = route[sourceIndex]
      const previousCountryId = route[sourceIndex - 1]
      const nextCountryId = route[sourceIndex + 1] ?? null
      const removalDelta =
        nextCountryId === null
          ? -distanceBetween(previousCountryId, countryId)
          : distanceBetween(previousCountryId, nextCountryId) -
            distanceBetween(previousCountryId, countryId) -
            distanceBetween(countryId, nextCountryId)

      for (let targetIndex = 1; targetIndex <= route.length; targetIndex += 1) {
        if (targetIndex === sourceIndex || targetIndex === sourceIndex + 1) {
          continue
        }

        const insertAfterCountryId = route[targetIndex - 1]
        const insertBeforeCountryId = route[targetIndex] ?? null
        const insertionDelta =
          insertBeforeCountryId === null
            ? distanceBetween(insertAfterCountryId, countryId)
            : distanceBetween(insertAfterCountryId, countryId) +
              distanceBetween(countryId, insertBeforeCountryId) -
              distanceBetween(insertAfterCountryId, insertBeforeCountryId)
        const totalDelta = removalDelta + insertionDelta

        if (totalDelta >= -1e-12) {
          continue
        }

        route.splice(sourceIndex, 1)
        route.splice(targetIndex > sourceIndex ? targetIndex - 1 : targetIndex, 0, countryId)
        improved = true
        break
      }

      if (improved) {
        break
      }
    }
  }

  return route
}

const countryFeatures = feature(topology, topology.objects.countries).features
const atlasFeatureByCcn3 = new Map()
const atlasFeatureByName = new Map()

for (const featureEntry of countryFeatures) {
  const atlasId = normaliseAtlasId(featureEntry.id)

  if (atlasId) {
    atlasFeatureByCcn3.set(atlasId, featureEntry)
  }

  if (featureEntry.properties?.name) {
    atlasFeatureByName.set(featureEntry.properties.name, featureEntry)
  }
}

const centroidByCountryId = new Map()

for (const country of countries) {
  const atlasFeature =
    atlasFeatureByName.get(country.atlasName) ??
    (country.ccn3 ? atlasFeatureByCcn3.get(normaliseAtlasId(country.ccn3)) : undefined)
  const fallbackFeature = fallbackFeatures.find((featureEntry) => {
    return (
      normaliseAtlasId(featureEntry.id) === normaliseAtlasId(country.ccn3) ||
      featureEntry.properties?.name === country.atlasName
    )
  })
  const matchedFeature = atlasFeature ?? fallbackFeature

  if (!matchedFeature) {
    throw new Error(`Missing geometry for ${country.id} (${country.name})`)
  }

  const normalisedFeature = normaliseCountryFeature(matchedFeature)
  const centroid = geoCentroid(primaryLabelFeature(normalisedFeature))

  if (!Array.isArray(centroid) || centroid.length !== 2) {
    throw new Error(`Could not compute centroid for ${country.id} (${country.name})`)
  }

  centroidByCountryId.set(country.id, centroid)
}

const countryIds = countries.map((country) => country.id)
const cachedDistances = new Map()

function distanceBetween(countryIdA, countryIdB) {
  const cacheKey = countryIdA < countryIdB ? `${countryIdA}|${countryIdB}` : `${countryIdB}|${countryIdA}`

  if (cachedDistances.has(cacheKey)) {
    return cachedDistances.get(cacheKey)
  }

  const centroidA = centroidByCountryId.get(countryIdA)
  const centroidB = centroidByCountryId.get(countryIdB)

  if (!centroidA || !centroidB) {
    throw new Error(`Missing centroid for ${countryIdA} or ${countryIdB}`)
  }

  const distance = geoDistance(centroidA, centroidB)
  cachedDistances.set(cacheKey, distance)
  return distance
}

const random = createSeededRandom(RNG_SEED)
let bestRoute = null
let bestAngularDistance = Number.POSITIVE_INFINITY

for (let iteration = 0; iteration < ITERATION_COUNT; iteration += 1) {
  const baseRoute =
    iteration % 2 === 0
      ? buildNearestNeighborRoute(countryIds, distanceBetween, random)
      : buildCheapestInsertionRoute(countryIds, distanceBetween, random)
  const improvedRoute = applyRelocate(applyTwoOpt(baseRoute, distanceBetween), distanceBetween)
  const angularDistance = routeDistance(improvedRoute, distanceBetween)

  if (angularDistance >= bestAngularDistance) {
    continue
  }

  bestRoute = improvedRoute.slice()
  bestAngularDistance = angularDistance
}

if (!bestRoute) {
  throw new Error('Route search did not produce an ordering')
}

const output = {
  startingCountryId: START_COUNTRY_ID,
  generatedAt: new Date().toISOString(),
  method:
    'Centroid-distance multi-start heuristic: nearest-neighbour and cheapest-insertion seeds with 2-opt and relocate local search.',
  angularDistance: Number(bestAngularDistance.toFixed(12)),
  estimatedMiles: Math.round(bestAngularDistance * EARTH_RADIUS_MILES),
  orderedCountryIds: bestRoute,
}

const outputPath = path.resolve('src/generated/route-challenge-order.json')
await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`)

console.log(
  `Wrote ${output.orderedCountryIds.length} route stops to ${outputPath} (${output.estimatedMiles.toLocaleString('en-GB')} miles)`,
)
