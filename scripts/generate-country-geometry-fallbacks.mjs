import fs from 'node:fs/promises'
import path from 'node:path'

import { feature } from 'topojson-client'

import atlas10 from 'world-atlas/countries-10m.json' with { type: 'json' }
import atlas50 from 'world-atlas/countries-50m.json' with { type: 'json' }
import quizCountries from '../src/generated/quiz-country-records.json' with { type: 'json' }

function atlasMatchesCountry(geometry, country) {
  const atlasId = geometry.id === undefined ? null : String(geometry.id).padStart(3, '0')
  return atlasId === country.ccn3 || geometry.properties?.name === country.atlasName
}

const atlas50Features = feature(atlas50, atlas50.objects.countries).features
const atlas10Features = feature(atlas10, atlas10.objects.countries).features

const missingCountries = quizCountries.filter((country) => {
  return !atlas50Features.some((geometry) => atlasMatchesCountry(geometry, country))
})

const fallbackFeatures = missingCountries
  .map((country) => atlas10Features.find((geometry) => atlasMatchesCountry(geometry, country)))
  .filter(Boolean)

const outputPath = path.resolve('src/generated/country-geometry-fallbacks.json')
await fs.writeFile(outputPath, `${JSON.stringify(fallbackFeatures, null, 2)}\n`)

console.log(
  `Wrote ${fallbackFeatures.length} fallback geometries for ${missingCountries.length} countries to ${outputPath}`,
)
