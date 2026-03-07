import fs from 'node:fs/promises'
import path from 'node:path'

import rawCountries from 'world-countries'

const INCLUDED_NON_UN_MEMBERS = new Set(['PSE', 'TWN', 'VAT', 'UNK'])

const MANUAL_ALIASES = {
  ARE: ['uae'],
  BOL: ['bolivia'],
  BRN: ['brunei'],
  CIV: ['ivory coast'],
  COD: [
    'dr congo',
    'drc',
    'democratic republic of congo',
    'democratic republic of the congo',
    'congo kinshasa',
  ],
  COG: ['republic of the congo', 'congo brazzaville'],
  CPV: ['cape verde'],
  CZE: ['czech republic'],
  FSM: ['micronesia'],
  GBR: ['uk', 'britain', 'great britain'],
  KNA: ['saint kitts', 'saint kitts and nevis', 'st kitts', 'st kitts and nevis'],
  KOR: ['south korea', 'republic of korea'],
  LAO: ['laos'],
  LCA: ['saint lucia', 'st lucia'],
  MDA: ['moldova'],
  MKD: ['macedonia'],
  PRK: ['north korea', 'dprk'],
  PSE: ['state of palestine'],
  RUS: ['russia'],
  STP: ['sao tome', 'sao tome and principe'],
  SWZ: ['swaziland'],
  SYR: ['syria'],
  TLS: ['east timor', 'timor leste'],
  TZA: ['tanzania'],
  USA: ['us', 'usa', 'united states of america', 'america'],
  VAT: ['holy see', 'vatican'],
  VCT: [
    'saint vincent',
    'saint vincent and the grenadines',
    'st vincent',
    'st vincent and the grenadines',
  ],
  VEN: ['venezuela'],
  VNM: ['vietnam'],
}

const CONTINENT_ORDER = [
  'Africa',
  'Asia',
  'Europe',
  'North America',
  'South America',
  'Oceania',
]

function normalizeAnswer(value) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/&/g, ' and ')
    .replace(/\bst[.]?\b/g, 'saint')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function toContinent(region, subregion) {
  if (region === 'Americas') {
    return ['Caribbean', 'Central America', 'North America'].includes(subregion)
      ? 'North America'
      : 'South America'
  }

  if (CONTINENT_ORDER.includes(region)) {
    return region
  }

  throw new Error(`Unsupported region: ${region}`)
}

function atlasNameFor(country) {
  if (country.cca3 === 'VAT') {
    return 'Vatican'
  }

  return country.name.common
}

function displayNameFor(country) {
  if (country.cca3 === 'VAT') {
    return 'Vatican City'
  }

  return country.name.common
}

function collectAliases(country, displayName) {
  const altSpellings = country.altSpellings.filter(
    (alias) => alias.trim().length >= 4 || /\s/.test(alias),
  )
  const aliasCandidates = [
    displayName,
    country.name.common,
    country.name.official,
    ...altSpellings,
    ...(MANUAL_ALIASES[country.cca3] ?? []),
  ]

  return [...new Set(aliasCandidates.map(normalizeAnswer).filter(Boolean))]
}

const records = rawCountries
  .filter((country) => country.unMember || INCLUDED_NON_UN_MEMBERS.has(country.cca3))
  .map((country) => {
    const name = displayNameFor(country)

    return {
      id: country.cca3,
      ccn3: country.ccn3 || null,
      name,
      atlasName: atlasNameFor(country),
      continent: toContinent(country.region, country.subregion),
      aliases: collectAliases(country, name),
      appearance: {
        kind: 'color',
        fill: '#f6c64d',
      },
    }
  })
  .sort((left, right) => {
    const continentDelta =
      CONTINENT_ORDER.indexOf(left.continent) - CONTINENT_ORDER.indexOf(right.continent)

    if (continentDelta !== 0) {
      return continentDelta
    }

    return left.name.localeCompare(right.name)
  })

const outputPath = path.resolve('src/generated/quiz-country-records.json')
await fs.writeFile(outputPath, `${JSON.stringify(records, null, 2)}\n`)

console.log(`Wrote ${records.length} quiz country records to ${outputPath}`)
