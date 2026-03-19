import './style.css'
import { registerSW } from 'virtual:pwa-register'

import {
  createGlobe,
  type GlobeFlightPerformance,
  type GlobeFlightStatus,
} from './globe'
import { normalizeAnswer } from './normalize'
import {
  aliasToCountryId,
  capitalAliasToCountryId,
  countriesByContinent,
  countriesById,
  quizCountries,
  totalCountryCount,
  type QuizCountry,
} from './quiz-data'
import { routeChallengeMetadata, routeChallengeOrder } from './route-order'

registerSW({ immediate: true })

const STARTING_COUNTRY_ID = 'GBR'
const MOBILE_CHEAT_HOLD_MS = 2000
const MODE_QUERY_PARAM = 'mode'
const SHOW_FLAGS_QUERY_PARAM = 'flags'
const LEGACY_SHOW_MAPS_QUERY_PARAM = 'maps'
const SHOW_CAPITALS_QUERY_PARAM = 'capitals'
const SHOW_COUNTRIES_QUERY_PARAM = 'countries'
const RANDOM_ROUTE_QUERY_PARAM = 'random-route'
const ROUTE_SEED_QUERY_PARAM = 'route-seed'
const SETTINGS_DIALOG_QUERY_PARAM = 'settings'

type LayoutMode = 'free' | 'route'
type AnswerKind = 'country' | 'capital'
type ModeKey = 'free' | 'route' | 'free-capitals' | 'route-capitals'
type PreAnswerLabelMode = 'none' | 'country' | 'capital'

type QuizSettings = {
  randomRoute: boolean
  routeSeed: string | null
  showCapitals: boolean
  showCountries: boolean
  showFlags: boolean
}

type ModeConfig = {
  answerKind: AnswerKind
  heading: string
  inputLabel: string
  layoutMode: LayoutMode
  modeEyebrow: string
  navLabel: string
  navTitle: string
  placeholder: string
  title: string
}

const MODE_CONFIGS: Record<ModeKey, ModeConfig> = {
  free: {
    answerKind: 'country',
    heading: 'Name all 197 countries in any order',
    inputLabel: 'Enter a country',
    layoutMode: 'free',
    modeEyebrow: 'Flight Path',
    navLabel: 'Countries',
    navTitle: 'Countries',
    placeholder: 'Start typing a country name...',
    title: 'Countries Quiz',
  },
  route: {
    answerKind: 'country',
    heading: 'Name the highlighted country',
    inputLabel: 'Type the highlighted country',
    layoutMode: 'route',
    modeEyebrow: 'Route Drill',
    navLabel: 'Specific Countries',
    navTitle: 'Specific Countries',
    placeholder: 'Type the highlighted country...',
    title: 'Countries Quiz - Route Drill',
  },
  'free-capitals': {
    answerKind: 'capital',
    heading: 'Name all 197 capital cities in any order',
    inputLabel: 'Enter a capital city',
    layoutMode: 'free',
    modeEyebrow: 'Flight Path',
    navLabel: 'Capitals',
    navTitle: 'Capitals',
    placeholder: 'Start typing a capital city...',
    title: 'Countries Quiz - Capital Cities',
  },
  'route-capitals': {
    answerKind: 'capital',
    heading: 'Name the highlighted capital city',
    inputLabel: "Type the highlighted country's capital city",
    layoutMode: 'route',
    modeEyebrow: 'Route Drill',
    navLabel: 'Specific Capitals',
    navTitle: 'Specific Capitals',
    placeholder: "Type the highlighted country's capital city...",
    title: 'Countries Quiz - Route Capitals',
  },
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)

  if (!element) {
    throw new Error(`Required element missing: ${selector}`)
  }

  return element
}

function readModeKey(): ModeKey {
  const rawMode = new URL(window.location.href).searchParams.get(MODE_QUERY_PARAM)

  if (rawMode === 'route' || rawMode === 'capitals' || rawMode === 'route-capitals') {
    return rawMode === 'capitals' ? 'free-capitals' : rawMode
  }

  return 'free'
}

function routeSeedFromText(value: string): number {
  let hash = 1779033703 ^ value.length

  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 3432918353)
    hash = (hash << 13) | (hash >>> 19)
  }

  hash = Math.imul(hash ^ (hash >>> 16), 2246822507)
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909)
  return (hash ^= hash >>> 16) >>> 0
}

function seededRandom(seed: string): () => number {
  let state = routeSeedFromText(seed) || 1

  return () => {
    state += 0x6d2b79f5
    let next = Math.imul(state ^ (state >>> 15), 1 | state)
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next)
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

function createRouteSeed(): string {
  return Math.random().toString(36).slice(2, 10)
}

function readBooleanSearchParam(searchParams: URLSearchParams, name: string): boolean {
  const value = searchParams.get(name)
  return value === '1' || value === 'true'
}

function setBooleanSearchParam(searchParams: URLSearchParams, name: string, enabled: boolean): void {
  if (enabled) {
    searchParams.set(name, '1')
  } else {
    searchParams.delete(name)
  }
}

function urlPathWithQuery(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`
}

function readSettings(): QuizSettings {
  const url = new URL(window.location.href)
  const randomRoute = readBooleanSearchParam(url.searchParams, RANDOM_ROUTE_QUERY_PARAM)

  return {
    showFlags:
      readBooleanSearchParam(url.searchParams, SHOW_FLAGS_QUERY_PARAM) ||
      readBooleanSearchParam(url.searchParams, LEGACY_SHOW_MAPS_QUERY_PARAM),
    showCapitals: readBooleanSearchParam(url.searchParams, SHOW_CAPITALS_QUERY_PARAM),
    showCountries: readBooleanSearchParam(url.searchParams, SHOW_COUNTRIES_QUERY_PARAM),
    randomRoute,
    routeSeed: randomRoute ? url.searchParams.get(ROUTE_SEED_QUERY_PARAM) ?? createRouteSeed() : null,
  }
}

function modeUrl(modeKey: ModeKey, options?: { settingsOpen?: boolean }): string {
  const url = new URL(window.location.href)

  switch (modeKey) {
    case 'free':
      url.searchParams.delete(MODE_QUERY_PARAM)
      break
    case 'route':
      url.searchParams.set(MODE_QUERY_PARAM, 'route')
      break
    case 'free-capitals':
      url.searchParams.set(MODE_QUERY_PARAM, 'capitals')
      break
    case 'route-capitals':
      url.searchParams.set(MODE_QUERY_PARAM, 'route-capitals')
      break
  }

  setBooleanSearchParam(url.searchParams, SETTINGS_DIALOG_QUERY_PARAM, options?.settingsOpen ?? false)

  return urlPathWithQuery(url)
}

const modeKey = readModeKey()
const mode = MODE_CONFIGS[modeKey]
let settings = readSettings()
const settingsOpenOnLoad = readBooleanSearchParam(
  new URL(window.location.href).searchParams,
  SETTINGS_DIALOG_QUERY_PARAM,
)

function syncSettingsUrl(): void {
  const url = new URL(window.location.href)
  setBooleanSearchParam(url.searchParams, SHOW_FLAGS_QUERY_PARAM, settings.showFlags)
  url.searchParams.delete(LEGACY_SHOW_MAPS_QUERY_PARAM)
  setBooleanSearchParam(url.searchParams, SHOW_CAPITALS_QUERY_PARAM, settings.showCapitals)
  setBooleanSearchParam(url.searchParams, SHOW_COUNTRIES_QUERY_PARAM, settings.showCountries)
  setBooleanSearchParam(url.searchParams, RANDOM_ROUTE_QUERY_PARAM, settings.randomRoute)

  if (settings.randomRoute && settings.routeSeed) {
    url.searchParams.set(ROUTE_SEED_QUERY_PARAM, settings.routeSeed)
  } else {
    url.searchParams.delete(ROUTE_SEED_QUERY_PARAM)
  }

  window.history.replaceState(null, '', urlPathWithQuery(url))
}

function routeOrderForSettings(currentSettings: QuizSettings): string[] {
  if (!currentSettings.randomRoute || !currentSettings.routeSeed) {
    return [...routeChallengeOrder]
  }

  const random = seededRandom(currentSettings.routeSeed)
  const nextOrder = [...routeChallengeOrder]

  for (let index = nextOrder.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    ;[nextOrder[index], nextOrder[swapIndex]] = [nextOrder[swapIndex], nextOrder[index]]
  }

  return nextOrder
}

syncSettingsUrl()

const aliasMap = mode.answerKind === 'capital' ? capitalAliasToCountryId : aliasToCountryId
const routePromptQueue = mode.layoutMode === 'route' ? routeOrderForSettings(settings) : []
let currentPromptId = mode.layoutMode === 'route' ? routePromptQueue[0] ?? null : null
const routeFlightOrder: string[] = []
let skippedPromptCount = 0

function answerLabelForCountry(country: QuizCountry): string {
  return mode.answerKind === 'capital' ? country.capitalDisplayName : country.name
}

function answerLabelForCountryId(countryId: string): string {
  const country = countriesById.get(countryId)
  return country ? answerLabelForCountry(country) : 'That answer'
}

function trackerPreviewLabelForCountry(country: QuizCountry, solved: boolean): string {
  if (mode.answerKind !== 'capital') {
    return solvedPreviewLabelForCountry(country)
  }

  return solved ? `${country.name} - ${country.capitalDisplayName}` : country.name
}

function solvedPreviewLabelForCountry(country: QuizCountry): string {
  return mode.answerKind === 'capital'
    ? `${country.name} - ${country.capitalDisplayName}`
    : country.name
}

function answerThing(): string {
  return mode.answerKind === 'capital' ? 'capital city' : 'country'
}

function answerThingPlural(): string {
  return mode.answerKind === 'capital' ? 'capital cities' : 'countries'
}

function preAnswerLabelMode(): PreAnswerLabelMode {
  if (mode.answerKind === 'country') {
    return settings.showCapitals ? 'capital' : 'none'
  }

  return settings.showCountries ? 'country' : 'none'
}

function renderModeLinksMarkup(options?: { settingsOpen?: boolean }): string {
  return (['free', 'route', 'free-capitals', 'route-capitals'] satisfies ModeKey[])
    .map((candidate) => {
      const candidateMode = MODE_CONFIGS[candidate]
      return `
        <a
          class="mode-switch__link ${modeKey === candidate ? 'mode-switch__link--active' : ''}"
          href="${modeUrl(candidate, options)}"
          title="${candidateMode.navTitle}"
        >
          ${candidateMode.navLabel}
        </a>
      `
    })
    .join('')
}

function renderModeDropdownLinksMarkup(): string {
  return (['free', 'route', 'free-capitals', 'route-capitals'] satisfies ModeKey[])
    .map((candidate) => {
      const candidateMode = MODE_CONFIGS[candidate]
      return `
        <a
          class="mode-dropdown__link ${modeKey === candidate ? 'mode-dropdown__link--active' : ''}"
          href="${modeUrl(candidate)}"
          title="${candidateMode.navTitle}"
        >
          ${candidateMode.navLabel}
        </a>
      `
    })
    .join('')
}

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('App root not found')
}

document.title = mode.title

app.innerHTML = `
  <main class="shell">
    <section class="hero">
      <div class="hero__copy">
        <div class="hero__header">
          <div class="hero__topbar">
            <button
              id="settings-button"
              class="settings-button"
              type="button"
              aria-haspopup="dialog"
              aria-controls="settings-modal"
              aria-expanded="false"
              title="Open settings"
            >
              <span aria-hidden="true">⚙</span>
              <span class="settings-button__label">Settings</span>
            </button>
            <details class="mode-dropdown">
              <summary class="mode-dropdown__trigger" aria-label="Game mode">
                <span class="mode-dropdown__prefix">Game mode:</span>
                <span class="mode-dropdown__label">${mode.navLabel}</span>
                <span class="mode-dropdown__chevron" aria-hidden="true">▾</span>
              </summary>
              <nav class="mode-dropdown__menu" aria-label="Game mode">
                ${renderModeDropdownLinksMarkup()}
              </nav>
            </details>
          </div>
          <div class="hero__headline">
            <h1>${mode.heading}</h1>
          </div>
        </div>
        <div class="hero__stats">
          <article class="stat-card">
            <span class="stat-card__label">Score</span>
            <strong id="score" class="stat-card__value">0/${totalCountryCount} ${answerThingPlural()}</strong>
            <span class="stat-card__meta">${mode.answerKind === 'capital' ? 'capital cities solved' : 'countries found'}</span>
          </article>
          <article class="stat-card stat-card--timer">
            <div class="stat-card__header">
              <span class="stat-card__label">Time</span>
              <div class="stat-card__actions">
                ${
                  mode.layoutMode === 'route'
                    ? '<button id="skip-button" class="skip-button skip-button--desktop" type="button">Skip</button>'
                    : ''
                }
                <button id="give-up-button" class="give-up-button" type="button">Give up</button>
              </div>
            </div>
            <strong id="timer" class="stat-card__value">00:00</strong>
            <span id="remaining" class="stat-card__meta">${totalCountryCount} left</span>
          </article>
        </div>
        <div class="answer-panel">
          <div class="answer-panel__heading">
            <div class="answer-panel__summary" aria-live="polite">
              <span id="score-compact" class="answer-panel__summary-text">0/${totalCountryCount}</span>
              <span class="answer-panel__summary-separator" aria-hidden="true">·</span>
              <span id="timer-compact" class="answer-panel__summary-text">00:00</span>
              ${
                mode.layoutMode === 'route'
                  ? '<button id="skip-button-compact" class="skip-button skip-button--compact" type="button">Skip</button>'
                  : ''
              }
              <button
                id="give-up-button-compact"
                class="give-up-button give-up-button--compact"
                type="button"
              >
                Give up
              </button>
            </div>
          </div>
          <input
            id="guess-input"
            name="guess"
            class="answer-panel__input"
            type="search"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="words"
            spellcheck="false"
            inputmode="search"
            enterkeyhint="search"
            aria-label="${mode.inputLabel}"
            placeholder="${mode.placeholder}"
          />
          <p id="status" class="status" aria-live="polite"></p>
        </div>
      </div>
      <section class="flight-panel hero__flight-panel" aria-live="polite">
        <div class="flight-panel__header">
          <p id="flight-eyebrow" class="flight-panel__eyebrow">${mode.modeEyebrow}</p>
        </div>
        <strong id="flight-route" class="flight-panel__route"></strong>
        <span id="flight-distance" class="flight-panel__meta"></span>
        <span id="flight-total" class="flight-panel__meta"></span>
      </section>
      <div class="globe-card">
        <div class="globe-card__toolbar">
          <div class="zoom-controls" aria-label="Globe zoom controls">
            <button id="zoom-out" class="zoom-controls__button" type="button" aria-label="Zoom out">−</button>
            <button id="zoom-in" class="zoom-controls__button" type="button" aria-label="Zoom in">+</button>
          </div>
        </div>
        <div id="globe" class="globe-frame"></div>
      </div>
    </section>
    <section class="tracker">
      <div class="tracker__header">
        <p class="eyebrow">Continent Tracker</p>
      </div>
      <div id="continent-board" class="continent-board"></div>
    </section>
  </main>
  <div id="settings-modal" class="settings-modal" hidden>
    <section
      class="settings-modal__panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <div class="settings-modal__header">
        <div>
          <p class="eyebrow settings-modal__eyebrow">Settings</p>
          <h2 id="settings-title" class="settings-modal__title">Quiz Options</h2>
        </div>
        <button id="settings-close" class="settings-close" type="button" aria-label="Close settings">×</button>
      </div>
      <section class="settings-modal__modes" aria-labelledby="settings-modes-title">
        <p id="settings-modes-title" class="settings-modal__section-title">Mode</p>
        <nav class="mode-switch mode-switch--settings" aria-label="Mobile game mode">
          ${renderModeLinksMarkup({ settingsOpen: true })}
        </nav>
      </section>
      <div class="settings-list">
        <label class="settings-option" for="setting-show-flags">
          <span class="settings-option__copy">
            <span class="settings-option__title">Show flags</span>
            <span class="settings-option__description">Show country flags on the globe before the answer is solved.</span>
          </span>
          <input id="setting-show-flags" class="settings-option__toggle" type="checkbox" ${settings.showFlags ? 'checked' : ''} />
        </label>
        <label class="settings-option ${mode.answerKind === 'country' ? '' : 'settings-option--disabled'}" for="setting-show-capitals">
          <span class="settings-option__copy">
            <span class="settings-option__title">Show capitals</span>
            <span class="settings-option__description">In country entry modes, show capital-city labels before the country is solved.</span>
          </span>
          <input id="setting-show-capitals" class="settings-option__toggle" type="checkbox" ${settings.showCapitals ? 'checked' : ''} ${mode.answerKind === 'country' ? '' : 'disabled'} />
        </label>
        <label class="settings-option ${mode.answerKind === 'capital' ? '' : 'settings-option--disabled'}" for="setting-show-countries">
          <span class="settings-option__copy">
            <span class="settings-option__title">Show countries</span>
            <span class="settings-option__description">In capital entry modes, show country-name labels before the capital is solved.</span>
          </span>
          <input id="setting-show-countries" class="settings-option__toggle" type="checkbox" ${settings.showCountries ? 'checked' : ''} ${mode.answerKind === 'capital' ? '' : 'disabled'} />
        </label>
        <label class="settings-option ${mode.layoutMode === 'route' ? '' : 'settings-option--disabled'}" for="setting-random-route">
          <span class="settings-option__copy">
            <span class="settings-option__title">Random route</span>
            <span class="settings-option__description">In route drills, use a seeded random order instead of the travelling-salesman route.</span>
          </span>
          <input id="setting-random-route" class="settings-option__toggle" type="checkbox" ${settings.randomRoute ? 'checked' : ''} ${mode.layoutMode === 'route' ? '' : 'disabled'} />
        </label>
      </div>
    </section>
  </div>
`

const scoreElement = requireElement<HTMLElement>('#score')
const compactScoreElement = requireElement<HTMLElement>('#score-compact')
const timerElement = requireElement<HTMLElement>('#timer')
const compactTimerElement = requireElement<HTMLElement>('#timer-compact')
const remainingElement = requireElement<HTMLElement>('#remaining')
const statusElement = requireElement<HTMLElement>('#status')
const answerInput = requireElement<HTMLInputElement>('#guess-input')
const flightEyebrowElement = requireElement<HTMLElement>('#flight-eyebrow')
const flightRouteElement = requireElement<HTMLElement>('#flight-route')
const flightDistanceElement = requireElement<HTMLElement>('#flight-distance')
const flightTotalElement = requireElement<HTMLElement>('#flight-total')
const continentBoard = requireElement<HTMLElement>('#continent-board')
const zoomInButton = requireElement<HTMLButtonElement>('#zoom-in')
const zoomOutButton = requireElement<HTMLButtonElement>('#zoom-out')
const globeContainer = requireElement<HTMLElement>('#globe')
const giveUpButton = requireElement<HTMLButtonElement>('#give-up-button')
const compactGiveUpButton = requireElement<HTMLButtonElement>('#give-up-button-compact')
const skipButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#skip-button, #skip-button-compact'))
const settingsButton = requireElement<HTMLButtonElement>('#settings-button')
const settingsModal = requireElement<HTMLElement>('#settings-modal')
const settingsCloseButton = requireElement<HTMLButtonElement>('#settings-close')
const showFlagsInput = requireElement<HTMLInputElement>('#setting-show-flags')
const showCapitalsInput = requireElement<HTMLInputElement>('#setting-show-capitals')
const showCountriesInput = requireElement<HTMLInputElement>('#setting-show-countries')
const randomRouteInput = requireElement<HTMLInputElement>('#setting-random-route')

const answeredIds = new Set<string>()
const cheatedIds = new Set<string>()
const skippedIds = new Set<string>()
const answerOrder: string[] = []
let quizStartedAt: number | null = null
let statusTone: 'neutral' | 'success' | 'muted' = 'neutral'
let intervalHandle = window.setInterval(tick, 250)
let quizFinished = false
let globe: Awaited<ReturnType<typeof createGlobe>> | null = null
let latestFlightPerformance: GlobeFlightPerformance | null = null
const trackerSlotByCountryId = new Map<string, HTMLLIElement>()
const trackerSolvedCountByContinent = new Map<string, HTMLElement>()

function attachTrackerCheatInteractions(slot: HTMLLIElement, countryId: string): void {
  if (mode.layoutMode !== 'free') {
    return
  }

  let holdTimeoutId: number | null = null
  let startX: number | null = null
  let startY: number | null = null

  const clearHold = (): void => {
    if (holdTimeoutId !== null) {
      window.clearTimeout(holdTimeoutId)
      holdTimeoutId = null
    }

    startX = null
    startY = null
  }

  slot.addEventListener('click', (event: MouseEvent) => {
    if (!event.shiftKey) {
      return
    }

    event.preventDefault()
    solveCountry(countryId, 'cheat')
  })

  slot.addEventListener(
    'touchstart',
    (event: TouchEvent) => {
      clearHold()

      if (event.touches.length !== 1 || answeredIds.has(countryId) || quizFinished) {
        return
      }

      const touch = event.touches[0]
      startX = touch.clientX
      startY = touch.clientY
      holdTimeoutId = window.setTimeout(() => {
        clearHold()
        solveCountry(countryId, 'cheat')
      }, MOBILE_CHEAT_HOLD_MS)
    },
    { passive: true },
  )

  slot.addEventListener(
    'touchmove',
    (event: TouchEvent) => {
      if (event.touches.length !== 1 || startX === null || startY === null) {
        clearHold()
        return
      }

      const touch = event.touches[0]

      if (touch.clientX !== startX || touch.clientY !== startY) {
        clearHold()
      }
    },
    { passive: true },
  )

  slot.addEventListener('touchend', clearHold)
  slot.addEventListener('touchcancel', clearHold)
}

function createTrackerFlagNode(countryId: string, previewText: string): HTMLElement | null {
  const country = countriesById.get(countryId)

  if (!country || country.appearance.kind !== 'flag') {
    return null
  }

  const anchor = document.createElement('span')
  anchor.className = 'country-slot__flag-anchor'
  anchor.setAttribute('aria-hidden', 'true')

  const icon = document.createElement('img')
  icon.className = 'country-slot__flag-icon'
  icon.src = country.appearance.assetUrl
  icon.alt = ''
  icon.loading = 'lazy'

  const preview = document.createElement('span')
  preview.className = 'country-slot__flag-preview'

  const previewImage = document.createElement('img')
  previewImage.className = 'country-slot__flag-preview-image'
  previewImage.src = country.appearance.assetUrl
  previewImage.alt = ''
  previewImage.loading = 'lazy'

  const previewLabel = document.createElement('span')
  previewLabel.className = 'country-slot__flag-preview-label'
  previewLabel.textContent = previewText

  preview.append(previewImage, previewLabel)
  anchor.append(icon, preview)
  return anchor
}

function trackerPrimaryText(country: QuizCountry, solved: boolean): string | null {
  if (solved) {
    return country.name
  }

  if (mode.answerKind === 'capital' && settings.showCountries) {
    return country.name
  }

  return null
}

function trackerSecondaryText(country: QuizCountry, solved: boolean): string | null {
  if (solved) {
    return country.capitalDisplayName
  }

  if (mode.answerKind === 'country' && settings.showCapitals) {
    return country.capitalDisplayName
  }

  return null
}

function trackerShowsFlag(solved: boolean): boolean {
  return solved || settings.showFlags
}

function trackerUsesDetailedSlot(country: QuizCountry): boolean {
  const solved = answeredIds.has(country.id)
  return Boolean(
    solved ||
    trackerPrimaryText(country, solved) ||
    trackerSecondaryText(country, solved) ||
    trackerShowsFlag(solved),
  )
}

function trackerSlotChars(country: QuizCountry): number {
  if (!trackerUsesDetailedSlot(country)) {
    return Math.max(6, country.name.length)
  }

  return Math.max(12, country.name.length, country.capitalDisplayName.length)
}

function applyTrackerSlot(slot: HTMLLIElement, countryId: string): void {
  const country = countriesById.get(countryId)

  if (!country) {
    return
  }

  const solved = answeredIds.has(countryId)
  const cheated = cheatedIds.has(countryId)
  const primaryText = trackerPrimaryText(country, solved)
  const secondaryText = trackerSecondaryText(country, solved)
  const showFlag = trackerShowsFlag(solved)
  const detailedSlot = Boolean(primaryText || secondaryText || showFlag)

  slot.className = [
    'country-slot',
    detailedSlot ? 'country-slot--capital' : 'country-slot--empty',
    detailedSlot ? (solved ? 'country-slot--solved' : 'country-slot--capital-pending') : '',
    cheated ? 'country-slot--cheated' : '',
  ]
    .filter(Boolean)
    .join(' ')
  slot.replaceChildren()

  if (!detailedSlot) {
    return
  }

  if (primaryText) {
    const name = document.createElement('span')
    name.className = 'country-slot__name'
    name.textContent = primaryText
    slot.append(name)
  }

  if (showFlag) {
    const flagNode = createTrackerFlagNode(countryId, trackerPreviewLabelForCountry(country, solved))

    if (flagNode) {
      slot.append(flagNode)
    }
  }

  if (secondaryText) {
    const capital = document.createElement('span')
    capital.className = 'country-slot__capital'
    capital.textContent = secondaryText

    slot.append(capital)
  }
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function formatMiles(miles: number): string {
  return `${new Intl.NumberFormat('en-GB').format(miles)} miles`
}

function formatFps(value: number | null): string {
  return value === null ? '--' : `${value.toFixed(1)}`
}

function elapsedMilliseconds(): number {
  if (quizStartedAt === null) {
    return 0
  }

  return Math.max(0, Date.now() - quizStartedAt)
}

function solvedCountByContinent(continent: string): number {
  return countriesByContinent
    .find((entry) => entry.continent === continent)
    ?.countries.filter((country) => answeredIds.has(country.id)).length ?? 0
}

function renderTracker(): void {
  continentBoard.replaceChildren()
  trackerSlotByCountryId.clear()
  trackerSolvedCountByContinent.clear()

  for (const { continent, countries } of countriesByContinent) {
    const section = document.createElement('section')
    section.className = 'continent-section'

    const header = document.createElement('div')
    header.className = 'continent-section__header'

    const title = document.createElement('h3')
    title.textContent = continent

    const count = document.createElement('span')
    count.textContent = `${solvedCountByContinent(continent)}/${countries.length}`
    trackerSolvedCountByContinent.set(continent, count)

    header.append(title, count)

    const list = document.createElement('ul')
    list.className = 'continent-section__list'

    for (const country of countries) {
      const slot = document.createElement('li')
      const slotChars = trackerSlotChars(country)
      slot.className = trackerUsesDetailedSlot(country)
        ? 'country-slot country-slot--capital country-slot--capital-pending'
        : 'country-slot country-slot--empty'
      slot.style.setProperty('--chars', String(slotChars))
      slot.dataset.countryId = country.id
      attachTrackerCheatInteractions(slot, country.id)
      trackerSlotByCountryId.set(country.id, slot)

      applyTrackerSlot(slot, country.id)

      list.append(slot)
    }

    section.append(header, list)
    continentBoard.append(section)
  }
}

function updateTracker(countryId: string): void {
  const slot = trackerSlotByCountryId.get(countryId)
  const country = countriesById.get(countryId)

  if (!slot || !country || !answeredIds.has(countryId)) {
    return
  }

  applyTrackerSlot(slot, countryId)

  const count = trackerSolvedCountByContinent.get(country.continent)

  if (count) {
    const totalForContinent =
      countriesByContinent.find((entry) => entry.continent === country.continent)?.countries.length ?? 0
    count.textContent = `${solvedCountByContinent(country.continent)}/${totalForContinent}`
  }
}

function renderScore(): void {
  scoreElement.textContent = `${answeredIds.size}/${totalCountryCount} ${answerThingPlural()}`
  compactScoreElement.textContent = `${answeredIds.size}/${totalCountryCount}`
  remainingElement.textContent = `${totalCountryCount - answeredIds.size} left`
}

function renderStatus(message: string): void {
  statusElement.textContent = message
  statusElement.dataset.tone = statusTone
}

function renderClassicFlightStatus(status: GlobeFlightStatus | null): void {
  flightEyebrowElement.textContent = 'Flight Path'

  if (!status) {
    const startCountry = countriesById.get(STARTING_COUNTRY_ID)
    flightRouteElement.textContent = `Plane standing by in ${startCountry?.name ?? answerLabelForCountryId(STARTING_COUNTRY_ID)}`
    flightDistanceElement.textContent = 'Leg distance: 0 miles'
    flightTotalElement.textContent = 'Total distance flown: 0 miles'
    return
  }

  flightRouteElement.textContent = `${status.fromName} to ${status.toName}`
  flightDistanceElement.textContent = `Leg distance: ${formatMiles(status.legMiles)}`
  flightTotalElement.textContent = `Total distance flown: ${formatMiles(status.totalMiles)}`
}

function renderRoutePanel(): void {
  flightEyebrowElement.textContent = 'Route Drill'

  if (quizFinished && answeredIds.size === totalCountryCount) {
    flightRouteElement.textContent = 'Route complete'
  } else if (!currentPromptId) {
    flightRouteElement.textContent = 'No highlighted country queued'
  } else {
    flightRouteElement.textContent = `Target ${answeredIds.size + 1} of ${totalCountryCount}`
  }

  flightDistanceElement.textContent = settings.randomRoute
    ? `Random order from the United Kingdom${settings.routeSeed ? ` (seed ${settings.routeSeed})` : ''}.`
    : `Default order: ${formatMiles(routeChallengeMetadata.estimatedMiles)} from the United Kingdom.`
  flightTotalElement.textContent =
    skippedPromptCount === 1 ? '1 skip used' : `${skippedPromptCount} skips used`

  for (const skipButton of skipButtons) {
    skipButton.disabled = quizFinished || routePromptQueue.length < 2
  }
}

function syncSettingsForm(): void {
  showFlagsInput.checked = settings.showFlags
  showCapitalsInput.checked = settings.showCapitals
  showCountriesInput.checked = settings.showCountries
  randomRouteInput.checked = settings.randomRoute
}

function syncSettingsDialogUrl(open: boolean): void {
  const url = new URL(window.location.href)
  setBooleanSearchParam(url.searchParams, SETTINGS_DIALOG_QUERY_PARAM, open)
  window.history.replaceState(null, '', urlPathWithQuery(url))
}

function openSettings(): void {
  settingsButton.setAttribute('aria-expanded', 'true')
  settingsModal.hidden = false
  document.body.dataset.settingsOpen = 'true'
  syncSettingsDialogUrl(true)
  settingsCloseButton.focus()
}

function closeSettings(): void {
  settingsButton.setAttribute('aria-expanded', 'false')
  settingsModal.hidden = true
  delete document.body.dataset.settingsOpen
  syncSettingsDialogUrl(false)
  answerInput.focus()
}

function rebuildRoutePromptQueue(): void {
  if (mode.layoutMode !== 'route') {
    return
  }

  const nextOrder = routeOrderForSettings(settings).filter((countryId) => !answeredIds.has(countryId))
  const keepCurrentPrompt = answeredIds.size > 0 && currentPromptId && nextOrder.includes(currentPromptId)

  routePromptQueue.length = 0

  if (keepCurrentPrompt && currentPromptId) {
    routePromptQueue.push(currentPromptId, ...nextOrder.filter((countryId) => countryId !== currentPromptId))
  } else {
    routePromptQueue.push(...nextOrder)
  }

  currentPromptId = routePromptQueue[0] ?? null
}

function applySettings(nextSettings: QuizSettings): void {
  const previousRandomRoute = settings.randomRoute
  const previousRouteSeed = settings.routeSeed

  settings = {
    ...nextSettings,
    routeSeed: nextSettings.randomRoute ? nextSettings.routeSeed ?? createRouteSeed() : null,
  }
  syncSettingsUrl()
  syncSettingsForm()
  renderTracker()

  if (
    mode.layoutMode === 'route' &&
    (settings.randomRoute !== previousRandomRoute || settings.routeSeed !== previousRouteSeed)
  ) {
    rebuildRoutePromptQueue()
  }

  syncSolvedCountries()

  if (mode.layoutMode === 'route') {
    syncPromptedCountry({ focus: answeredIds.size === 0 })
    renderRoutePanel()
  }
}

function renderFlightPerformance(performance: GlobeFlightPerformance | null): void {
  latestFlightPerformance = performance
}

function syncSolvedCountries(options?: { focusLatest?: boolean }): void {
  globe?.setAnswered(answeredIds, {
    cheatedIds,
    focusLatest: options?.focusLatest,
    answerKind: mode.answerKind,
    preAnswerLabelMode: preAnswerLabelMode(),
    layoutMode: mode.layoutMode,
    showAllCountryLabels: preAnswerLabelMode() !== 'none' || settings.showFlags,
    showPreAnswerFlags: settings.showFlags,
    skippedIds,
  })
}

function syncPromptedCountry(options?: { focus?: boolean }): void {
  if (mode.layoutMode !== 'route') {
    return
  }

  globe?.setPromptedCountry(currentPromptId, { focus: options?.focus })
}

function advanceRouteFlight(options?: { animate?: boolean }): void {
  if (mode.layoutMode !== 'route' || !currentPromptId) {
    return
  }

  routeFlightOrder.push(currentPromptId)
  globe?.syncFlightPath(routeFlightOrder, { animate: options?.animate })
}

function finishQuiz(
  message: string,
  options?: {
    timerText?: string
  },
): void {
  if (quizFinished) {
    return
  }

  quizFinished = true
  window.clearInterval(intervalHandle)
  answerInput.disabled = true
  giveUpButton.disabled = true
  compactGiveUpButton.disabled = true

  for (const skipButton of skipButtons) {
    skipButton.disabled = true
  }

  statusTone = 'muted'
  renderStatus(message)
  const finalTimerText = options?.timerText ?? '00:00'
  timerElement.textContent = finalTimerText
  compactTimerElement.textContent = finalTimerText

  if (mode.layoutMode === 'route') {
    renderRoutePanel()
  }
}

function giveUp(): void {
  if (quizFinished) {
    return
  }

  const solvedBeforeGiveUp = answeredIds.size
  const remainingCountryIds = quizCountries
    .map((country) => country.id)
    .filter((countryId) => !answeredIds.has(countryId))

  if (remainingCountryIds.length === 0) {
    return
  }

  for (const countryId of remainingCountryIds) {
    answeredIds.add(countryId)
    cheatedIds.add(countryId)
    answerOrder.push(countryId)
  }

  if (mode.layoutMode === 'route') {
    routePromptQueue.length = 0
    currentPromptId = null
  }

  answerInput.value = ''
  syncSolvedCountries()
  syncPromptedCountry()
  globe?.syncFlightPath([], { animate: false })
  globe?.resetView()
  renderScore()
  renderTracker()

  if (mode.layoutMode === 'route') {
    renderRoutePanel()
  } else {
    renderClassicFlightStatus(null)
  }

  const elapsedTimeText = formatTime(elapsedMilliseconds())
  const itemNoun = remainingCountryIds.length === 1 ? answerThing() : answerThingPlural()
  finishQuiz(
    `Gave up at ${solvedBeforeGiveUp}/${totalCountryCount}. Revealed ${remainingCountryIds.length} remaining ${itemNoun}.`,
    {
      timerText: elapsedTimeText,
    },
  )
}

function solveCountry(countryId: string, source: 'answer' | 'cheat' = 'answer'): void {
  const country = countriesById.get(countryId)

  if (!country || answeredIds.has(countryId) || quizFinished) {
    return
  }

  if (mode.layoutMode === 'route' && countryId !== currentPromptId) {
    return
  }

  answeredIds.add(countryId)

  if (quizStartedAt === null) {
    quizStartedAt = Date.now()
  }

  if (source === 'cheat') {
    cheatedIds.add(countryId)
  } else {
    cheatedIds.delete(countryId)
  }

  skippedIds.delete(countryId)
  answerOrder.push(countryId)

  if (mode.layoutMode === 'route') {
    routePromptQueue.shift()
    currentPromptId = routePromptQueue[0] ?? null
  }

  answerInput.value = ''
  syncSolvedCountries()
  renderScore()
  updateTracker(countryId)

  if (mode.layoutMode === 'route') {
    syncPromptedCountry()
    advanceRouteFlight({ animate: Boolean(currentPromptId) })
    renderRoutePanel()
  } else {
    renderClassicFlightStatus(globe?.syncFlightPath(answerOrder, { animate: true }) ?? null)
  }

  if (answeredIds.size === totalCountryCount) {
    const elapsedTimeText = formatTime(elapsedMilliseconds())
    finishQuiz(`All ${totalCountryCount} ${answerThingPlural()} solved in ${elapsedTimeText}.`, {
      timerText: elapsedTimeText,
    })
    return
  }

  statusTone = source === 'cheat' ? 'neutral' : 'success'
  renderStatus(
    source === 'cheat'
      ? `${answerLabelForCountry(country)} revealed via cheat.`
      : mode.answerKind === 'capital'
        ? `${country.capitalDisplayName} accepted for ${country.name}.`
        : `${country.name} accepted.`,
  )
}

function skipPrompt(): void {
  if (mode.layoutMode !== 'route' || quizFinished || !currentPromptId || routePromptQueue.length < 2) {
    return
  }

  const skippedCountryId = routePromptQueue.shift()

  if (!skippedCountryId) {
    return
  }

  routePromptQueue.push(skippedCountryId)
  currentPromptId = routePromptQueue[0] ?? null
  skippedIds.add(skippedCountryId)
  skippedPromptCount += 1
  answerInput.value = ''
  statusTone = 'neutral'
  renderStatus(`Skipped ${answerLabelForCountryId(skippedCountryId)}. It will come back later.`)
  syncSolvedCountries()
  syncPromptedCountry()
  advanceRouteFlight({ animate: true })
  renderRoutePanel()
  answerInput.focus()
}

function maybeAcceptGuess(): void {
  const normalizedGuess = normalizeAnswer(answerInput.value)

  if (!normalizedGuess || quizFinished) {
    return
  }

  const matchedCountryId = aliasMap.get(normalizedGuess)

  if (!matchedCountryId || answeredIds.has(matchedCountryId)) {
    return
  }

  if (mode.layoutMode === 'route') {
    if (matchedCountryId === currentPromptId) {
      solveCountry(matchedCountryId)
    }

    return
  }

  solveCountry(matchedCountryId)
}

function submitGuess(): void {
  const normalizedGuess = normalizeAnswer(answerInput.value)

  if (!normalizedGuess || quizFinished) {
    return
  }

  const matchedCountryId = aliasMap.get(normalizedGuess)

  if (!matchedCountryId) {
    return
  }

  if (answeredIds.has(matchedCountryId)) {
    statusTone = 'muted'
    renderStatus(`${answerLabelForCountryId(matchedCountryId)} is already solved.`)
    return
  }

  if (mode.layoutMode === 'route' && matchedCountryId !== currentPromptId) {
    statusTone = 'muted'
    renderStatus(`${answerLabelForCountryId(matchedCountryId)} is not the highlighted ${answerThing()}.`)
    return
  }

  solveCountry(matchedCountryId)
}

function tick(): void {
  if (quizFinished) {
    return
  }

  const timerText = formatTime(elapsedMilliseconds())
  timerElement.textContent = timerText
  compactTimerElement.textContent = timerText
}

answerInput.addEventListener('input', () => {
  maybeAcceptGuess()
})

answerInput.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key !== 'Enter') {
    return
  }

  event.preventDefault()
  submitGuess()
})

zoomInButton.addEventListener('click', () => globe?.zoomBy(1.28))
zoomOutButton.addEventListener('click', () => globe?.zoomBy(0.8))
giveUpButton.addEventListener('click', giveUp)
compactGiveUpButton.addEventListener('click', giveUp)
for (const skipButton of skipButtons) {
  skipButton.addEventListener('click', skipPrompt)
}
settingsButton.addEventListener('click', openSettings)
settingsCloseButton.addEventListener('click', closeSettings)
settingsModal.addEventListener('click', (event: MouseEvent) => {
  if (event.target === settingsModal) {
    closeSettings()
  }
})
showFlagsInput.addEventListener('change', () => {
  applySettings({
    ...settings,
    showFlags: showFlagsInput.checked,
  })
})
showCapitalsInput.addEventListener('change', () => {
  applySettings({
    ...settings,
    showCapitals: showCapitalsInput.checked,
  })
})
showCountriesInput.addEventListener('change', () => {
  applySettings({
    ...settings,
    showCountries: showCountriesInput.checked,
  })
})
randomRouteInput.addEventListener('change', () => {
  applySettings({
    ...settings,
    randomRoute: randomRouteInput.checked,
    routeSeed: randomRouteInput.checked ? settings.routeSeed ?? createRouteSeed() : null,
  })
})
window.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape' && !settingsModal.hidden) {
    event.preventDefault()
    closeSettings()
  }
})

renderScore()
renderTracker()
syncSettingsForm()
tick()

if (mode.layoutMode === 'route') {
  renderRoutePanel()
  renderStatus('')
} else {
  renderClassicFlightStatus(null)
  renderStatus('')
}

globe = await createGlobe(globeContainer, quizCountries, mode.layoutMode === 'free'
  ? {
    onCountryCheat(countryId) {
      solveCountry(countryId, 'cheat')
    },
    onFlightPerformanceChange(performance) {
      renderFlightPerformance(performance)
    },
  }
  : {
    onFlightPerformanceChange(performance) {
      renderFlightPerformance(performance)
    },
  })

window.__countriesQuizDebug = {
  benchmarkFlight(fromCountryId, toCountryId) {
    return (
      globe?.benchmarkFlight(fromCountryId, toCountryId).then((performance) => {
        if (performance) {
          console.info(
            `[countries-quiz] Flight benchmark ${performance.fromCountryId} -> ${performance.toCountryId}: avg ${formatFps(performance.averageFps)} fps, low ${formatFps(performance.minFps)} fps, ${performance.frameCount} frames, ${performance.elapsedMs} ms`,
            performance,
          )
        }

        return performance
      }) ?? Promise.resolve(null)
    )
  },
  benchmarkFlightTo(countryId) {
    return (
      globe?.benchmarkFlight(STARTING_COUNTRY_ID, countryId).then((performance) => {
        if (performance) {
          console.info(
            `[countries-quiz] Flight benchmark ${performance.fromCountryId} -> ${performance.toCountryId}: avg ${formatFps(performance.averageFps)} fps, low ${formatFps(performance.minFps)} fps, ${performance.frameCount} frames, ${performance.elapsedMs} ms`,
            performance,
          )
        }

        return performance
      }) ?? Promise.resolve(null)
    )
  },
  getFlightPerformance() {
    return latestFlightPerformance ? { ...latestFlightPerformance } : null
  },
}

syncSolvedCountries({ focusLatest: mode.layoutMode === 'free' })

if (mode.layoutMode === 'route') {
  globe.syncFlightPath([], { animate: false })
  syncPromptedCountry({ focus: true })
} else {
  renderClassicFlightStatus(globe.syncFlightPath(answerOrder, { animate: false }))
}

if (settingsOpenOnLoad) {
  openSettings()
} else {
  answerInput.focus()
}
