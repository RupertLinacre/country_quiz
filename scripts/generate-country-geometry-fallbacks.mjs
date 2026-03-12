import fs from 'node:fs/promises'
import path from 'node:path'

import { geoArea, geoCentroid, geoCircle } from 'd3'
import { feature } from 'topojson-client'

import atlas10 from 'world-atlas/countries-10m.json' with { type: 'json' }
import atlas50 from 'world-atlas/countries-50m.json' with { type: 'json' }
import quizCountries from '../src/generated/quiz-country-records.json' with { type: 'json' }

const TINY_COUNTRY_DOT_AREA_THRESHOLD = 0.00002
const TINY_COUNTRY_DOT_RADIUS_DEGREES = 0.16
const MAX_COUNTRY_POLYGON_AREA = Math.PI * 2

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

function normaliseCountryGeometry(geometry) {
  if (geometry.geometry.type === 'Polygon') {
    return {
      ...geometry,
      geometry: {
        ...geometry.geometry,
        coordinates: normalisePolygonCoordinates(geometry.geometry.coordinates),
      },
    }
  }

  if (geometry.geometry.type === 'MultiPolygon') {
    return {
      ...geometry,
      geometry: {
        ...geometry.geometry,
        coordinates: geometry.geometry.coordinates.map((polygonCoordinates) =>
          normalisePolygonCoordinates(polygonCoordinates),
        ),
      },
    }
  }

  return geometry
}

function atlasMatchesCountry(geometry, country) {
  const atlasId = geometry.id === undefined ? null : String(geometry.id).padStart(3, '0')
  return geometry.properties?.name === country.atlasName || (country.ccn3 && atlasId === country.ccn3)
}

function shouldRenderAsTinyCountryDot(geometry) {
  return geoArea(geometry) <= TINY_COUNTRY_DOT_AREA_THRESHOLD
}

function createTinyCountryDotFeature(geometry) {
  const [longitude, latitude] = geoCentroid(geometry)

  return {
    type: 'Feature',
    id: geometry.id,
    properties: {
      ...geometry.properties,
      tinyCountryDot: true,
    },
    geometry: geoCircle()
      .center([longitude, latitude])
      .radius(TINY_COUNTRY_DOT_RADIUS_DEGREES)(),
  }
}

const atlas50Features = feature(atlas50, atlas50.objects.countries).features
const atlas10Features = feature(atlas10, atlas10.objects.countries).features

const fallbackFeatures = quizCountries
  .map((country) => {
    const geometry50Source = atlas50Features.find((geometry) => atlasMatchesCountry(geometry, country))
    const geometry10Source = atlas10Features.find((geometry) => atlasMatchesCountry(geometry, country))
    const geometry50 = geometry50Source ? normaliseCountryGeometry(geometry50Source) : null
    const geometry10 = geometry10Source ? normaliseCountryGeometry(geometry10Source) : null
    const referenceGeometry = geometry10 ?? geometry50

    if (!referenceGeometry) {
      return null
    }

    if (shouldRenderAsTinyCountryDot(referenceGeometry)) {
      return createTinyCountryDotFeature(referenceGeometry)
    }

    return null
  })
  .filter(Boolean)

const outputPath = path.resolve('src/generated/country-geometry-fallbacks.json')
await fs.writeFile(outputPath, `${JSON.stringify(fallbackFeatures, null, 2)}\n`)

console.log(
  `Wrote ${fallbackFeatures.length} fallback/override geometries to ${outputPath}`,
)
