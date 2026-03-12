/// <reference types="vite-plugin-pwa/client" />

declare module 'world-countries' {
  const countries: unknown[]
  export default countries
}

declare module '*.json?url' {
  const assetUrl: string
  export default assetUrl
}

interface Window {
  __countriesQuizDebug?: {
    benchmarkFlight: (
      fromCountryId: string,
      toCountryId: string,
    ) => Promise<import('./globe').GlobeFlightPerformance | null>
    benchmarkFlightTo: (
      countryId: string,
    ) => Promise<import('./globe').GlobeFlightPerformance | null>
    getFlightPerformance: () => import('./globe').GlobeFlightPerformance | null
  }
}
