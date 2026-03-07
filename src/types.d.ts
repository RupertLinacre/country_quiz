declare module 'world-countries' {
  const countries: unknown[]
  export default countries
}

declare module '*.json?url' {
  const assetUrl: string
  export default assetUrl
}
