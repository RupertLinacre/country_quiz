import fs from 'node:fs/promises'
import path from 'node:path'

import { quantize } from 'topojson-client'
import { presimplify, quantile, simplify } from 'topojson-simplify'

import atlas50 from 'world-atlas/countries-50m.json' with { type: 'json' }

const QUANTIZATION = 1e4
const SETTLED_QUANTILE = 0.32
const INTERACTION_QUANTILE = 0.1

function buildAtlas(sourceTopology, simplifyQuantile) {
  const topology = presimplify(structuredClone(sourceTopology))
  const simplified = simplify(topology, quantile(topology, simplifyQuantile))
  return quantize(simplified, QUANTIZATION)
}

const settledAtlas = buildAtlas(atlas50, SETTLED_QUANTILE)
const interactionAtlas = buildAtlas(atlas50, INTERACTION_QUANTILE)

const outputs = [
  ['src/generated/globe-atlas-settled.json', settledAtlas],
  ['src/generated/globe-atlas-interaction.json', interactionAtlas],
]

for (const [relativePath, topology] of outputs) {
  const outputPath = path.resolve(relativePath)
  const serialized = `${JSON.stringify(topology)}\n`
  await fs.writeFile(outputPath, serialized)
  console.log(`Wrote ${relativePath} (${serialized.length} bytes)`)
}
