import rawCountries from './generated/quiz-country-records.json'

import { normalizeAnswer } from './normalize'

export type Continent =
  | 'Africa'
  | 'Asia'
  | 'Europe'
  | 'North America'
  | 'South America'
  | 'Oceania'

export type SolvedAppearance =
  | {
      kind: 'color'
      fill: string
    }
  | {
      kind: 'flag'
      assetUrl: string
      fallbackFill: string
    }

export type QuizCountry = {
  id: string
  ccn3: string | null
  name: string
  atlasName: string
  continent: Continent
  aliases: string[]
  appearance: SolvedAppearance
}

export const continentOrder: Continent[] = [
  'Africa',
  'Asia',
  'Europe',
  'North America',
  'South America',
  'Oceania',
]

export const quizCountries = (rawCountries as QuizCountry[]).map((country) => ({
  ...country,
  aliases: [...new Set(country.aliases.map(normalizeAnswer).filter(Boolean))],
  appearance: country.appearance satisfies SolvedAppearance,
}))

export const totalCountryCount = quizCountries.length

export const countriesById = new Map(quizCountries.map((country) => [country.id, country]))

export const countriesByContinent = continentOrder.map((continent) => ({
  continent,
  countries: quizCountries.filter((country) => country.continent === continent),
}))

const aliasOwners = new Map<string, string[]>()

for (const country of quizCountries) {
  for (const alias of country.aliases) {
    const owners = aliasOwners.get(alias) ?? []
    owners.push(country.id)
    aliasOwners.set(alias, owners)
  }
}

export const aliasToCountryId = new Map<string, string>()

for (const country of quizCountries) {
  for (const alias of country.aliases) {
    const owners = aliasOwners.get(alias) ?? []

    if (owners.length === 1) {
      aliasToCountryId.set(alias, country.id)
    }
  }
}
