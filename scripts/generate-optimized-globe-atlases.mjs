import fs from 'node:fs/promises'
import path from 'node:path'

import { quantize } from 'topojson-client'
import { presimplify, quantile, simplify } from 'topojson-simplify'

import atlas50 from 'world-atlas/countries-50m.json' with { type: 'json' }

const QUANTIZATION = 4e4
const MAP_SIMPLIFY_QUANTILE = 0.2
const INTERACTION_SIMPLIFY_QUANTILE = 0.08

function buildAtlas(sourceTopology, simplifyQuantile) {
  const topology = presimplify(structuredClone(sourceTopology))
  const simplified = simplify(topology, quantile(topology, simplifyQuantile))
  return quantize(simplified, QUANTIZATION)
}

const atlas = buildAtlas(atlas50, MAP_SIMPLIFY_QUANTILE)
const outputPath = path.resolve('src/generated/globe-atlas.json')
const serialized = `${JSON.stringify(atlas)}\n`

await fs.writeFile(outputPath, serialized)
console.log(`Wrote src/generated/globe-atlas.json (${serialized.length} bytes)`)

const interactionAtlas = buildAtlas(atlas50, INTERACTION_SIMPLIFY_QUANTILE)
const interactionOutputPath = path.resolve('src/generated/globe-interaction-atlas.json')
const interactionSerialized = `${JSON.stringify(interactionAtlas)}\n`

await fs.writeFile(interactionOutputPath, interactionSerialized)
console.log(`Wrote src/generated/globe-interaction-atlas.json (${interactionSerialized.length} bytes)`)
