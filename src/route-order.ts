import rawRouteData from './generated/route-challenge-order.json'

import { countriesById, totalCountryCount } from './quiz-data'

type RouteChallengeData = {
  angularDistance: number
  estimatedMiles: number
  generatedAt: string
  method: string
  orderedCountryIds: string[]
  startingCountryId: string
}

const routeChallengeData = rawRouteData as RouteChallengeData
const uniqueRouteIds = [...new Set(routeChallengeData.orderedCountryIds)]

if (routeChallengeData.startingCountryId !== 'GBR') {
  throw new Error('Route challenge order must start at GBR.')
}

if (uniqueRouteIds.length !== totalCountryCount) {
  throw new Error(`Route challenge order must contain ${totalCountryCount} unique countries.`)
}

for (const countryId of uniqueRouteIds) {
  if (!countriesById.has(countryId)) {
    throw new Error(`Route challenge order includes unknown country id: ${countryId}`)
  }
}

export const routeChallengeOrder = uniqueRouteIds

export const routeChallengeMetadata = {
  angularDistance: routeChallengeData.angularDistance,
  estimatedMiles: routeChallengeData.estimatedMiles,
  generatedAt: routeChallengeData.generatedAt,
  method: routeChallengeData.method,
  startingCountryId: routeChallengeData.startingCountryId,
}
