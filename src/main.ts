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

type LayoutMode = 'free' | 'route'
type AnswerKind = 'country' | 'capital'
type ModeKey = 'free' | 'route' | 'free-capitals' | 'route-capitals'

type ModeConfig = {
  answerKind: AnswerKind
  heading: string
  inputLabel: string
  layoutMode: LayoutMode
  modeEyebrow: string
  navLabel: string
  navTitle: string
  placeholder: string
  routeStatusHint: string
  title: string
}

const MODE_CONFIGS: Record<ModeKey, ModeConfig> = {
  free: {
    answerKind: 'country',
    heading: 'Can you name all 197 countries of the world?',
    inputLabel: 'Enter a country',
    layoutMode: 'free',
    modeEyebrow: 'Flight Path',
    navLabel: 'Free Entry',
    navTitle: 'Countries',
    placeholder: 'Start typing a country name...',
    routeStatusHint: 'Type the highlighted country, or skip it for later.',
    title: 'Countries Quiz',
  },
  route: {
    answerKind: 'country',
    heading: 'Can you identify every highlighted country on the globe?',
    inputLabel: 'Type the highlighted country',
    layoutMode: 'route',
    modeEyebrow: 'Route Drill',
    navLabel: 'Route Drill',
    navTitle: 'Route Countries',
    placeholder: 'Type the highlighted country...',
    routeStatusHint: 'Type the highlighted country, or skip it for later.',
    title: 'Countries Quiz - Route Drill',
  },
  'free-capitals': {
    answerKind: 'capital',
    heading: 'Can you name all 197 capital cities of the world?',
    inputLabel: 'Enter a capital city',
    layoutMode: 'free',
    modeEyebrow: 'Flight Path',
    navLabel: 'Capital Entry',
    navTitle: 'Capitals',
    placeholder: 'Start typing a capital city...',
    routeStatusHint: "Type the highlighted country's capital city, or skip it for later.",
    title: 'Countries Quiz - Capital Cities',
  },
  'route-capitals': {
    answerKind: 'capital',
    heading: "Can you identify every highlighted country by its capital city?",
    inputLabel: "Type the highlighted country's capital city",
    layoutMode: 'route',
    modeEyebrow: 'Route Drill',
    navLabel: 'Capital Route',
    navTitle: 'Route Capitals',
    placeholder: "Type the highlighted country's capital city...",
    routeStatusHint: "Type the highlighted country's capital city, or skip it for later.",
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

function modeUrl(modeKey: ModeKey): string {
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

  return `${url.pathname}${url.search}${url.hash}`
}

const modeKey = readModeKey()
const mode = MODE_CONFIGS[modeKey]
const aliasMap = mode.answerKind === 'capital' ? capitalAliasToCountryId : aliasToCountryId
const routePromptQueue = mode.layoutMode === 'route' ? [...routeChallengeOrder] : []
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

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('App root not found')
}

document.title = mode.title

app.innerHTML = `
  <main class="shell">
    <section class="hero">
      <div class="hero__copy">
        <nav class="mode-switch" aria-label="Game mode">
          ${(['free', 'route', 'free-capitals', 'route-capitals'] satisfies ModeKey[])
            .map((candidate) => {
              const candidateMode = MODE_CONFIGS[candidate]
              return `
                <a
                  class="mode-switch__link ${modeKey === candidate ? 'mode-switch__link--active' : ''}"
                  href="${modeUrl(candidate)}"
                  title="${candidateMode.navTitle}"
                >
                  ${candidateMode.navLabel}
                </a>
              `
            })
            .join('')}
        </nav>
        <h1>${mode.heading}</h1>
        <div class="hero__stats">
          <article class="stat-card">
            <span class="stat-card__label">Score</span>
            <strong id="score" class="stat-card__value">0/${totalCountryCount} countries</strong>
            <span class="stat-card__meta">countries found</span>
          </article>
          <article class="stat-card stat-card--timer">
            <div class="stat-card__header">
              <span class="stat-card__label">Time</span>
              <button id="give-up-button" class="give-up-button" type="button">Give up</button>
            </div>
            <strong id="timer" class="stat-card__value">00:00</strong>
            <span id="remaining" class="stat-card__meta">${totalCountryCount} left</span>
          </article>
        </div>
        <div class="answer-panel">
          <div class="answer-panel__heading">
            <label class="answer-panel__label" for="guess-input">${mode.inputLabel}</label>
            <div class="answer-panel__summary" aria-live="polite">
              <span id="score-compact" class="answer-panel__summary-text">0/${totalCountryCount}</span>
              <span class="answer-panel__summary-separator" aria-hidden="true">·</span>
              <span id="timer-compact" class="answer-panel__summary-text">00:00</span>
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
            placeholder="${mode.placeholder}"
          />
          <p id="status" class="status" aria-live="polite"></p>
        </div>
      </div>
      <section class="flight-panel hero__flight-panel" aria-live="polite">
        <div class="flight-panel__header">
          <p id="flight-eyebrow" class="flight-panel__eyebrow">${mode.modeEyebrow}</p>
          ${
            mode.layoutMode === 'route'
              ? '<button id="skip-button" class="skip-button" type="button">Skip</button>'
              : ''
          }
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
const skipButton = document.querySelector<HTMLButtonElement>('#skip-button')

const answeredIds = new Set<string>(mode.layoutMode === 'free' ? [STARTING_COUNTRY_ID] : [])
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

function createSolvedFlagNode(countryId: string): HTMLElement | null {
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
  previewLabel.textContent = solvedPreviewLabelForCountry(country)

  preview.append(previewImage, previewLabel)
  anchor.append(icon, preview)
  return anchor
}

function applySolvedCountrySlot(slot: HTMLLIElement, countryId: string): void {
  const country = countriesById.get(countryId)

  if (!country) {
    return
  }

  const cheated = cheatedIds.has(countryId)
  slot.className = cheated
    ? 'country-slot country-slot--solved country-slot--cheated'
    : 'country-slot country-slot--solved'
  slot.replaceChildren()

  const flagNode = createSolvedFlagNode(countryId)
  const name = document.createElement('span')
  name.className = 'country-slot__name'
  name.textContent = answerLabelForCountry(country)

  if (flagNode) {
    slot.append(flagNode)
  }

  slot.append(name)
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
      const answerLabel = answerLabelForCountry(country)
      slot.className = 'country-slot country-slot--empty'
      slot.style.setProperty('--chars', String(Math.max(6, answerLabel.length)))
      slot.dataset.countryId = country.id
      attachTrackerCheatInteractions(slot, country.id)
      trackerSlotByCountryId.set(country.id, slot)

      if (answeredIds.has(country.id)) {
        applySolvedCountrySlot(slot, country.id)
      }

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

  if (!slot.classList.contains('country-slot--solved')) {
    applySolvedCountrySlot(slot, countryId)
  }

  const count = trackerSolvedCountByContinent.get(country.continent)

  if (count) {
    const totalForContinent =
      countriesByContinent.find((entry) => entry.continent === country.continent)?.countries.length ?? 0
    count.textContent = `${solvedCountByContinent(country.continent)}/${totalForContinent}`
  }
}

function renderScore(): void {
  scoreElement.textContent = `${answeredIds.size}/${totalCountryCount} countries`
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
    flightRouteElement.textContent = `Plane standing by in ${answerLabelForCountryId(STARTING_COUNTRY_ID)}`
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

  flightDistanceElement.textContent = `Default order: ${formatMiles(routeChallengeMetadata.estimatedMiles)} from the United Kingdom.`
  flightTotalElement.textContent =
    skippedPromptCount === 1 ? '1 skip used' : `${skippedPromptCount} skips used`

  if (skipButton) {
    skipButton.disabled = quizFinished || routePromptQueue.length < 2
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
    layoutMode: mode.layoutMode,
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

  if (skipButton) {
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
skipButton?.addEventListener('click', skipPrompt)

renderScore()
renderTracker()
tick()
answerInput.focus()

if (mode.layoutMode === 'route') {
  renderRoutePanel()
  renderStatus(mode.routeStatusHint)
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
