import './style.css'
import { registerSW } from 'virtual:pwa-register'

import { normalizeAnswer } from './normalize'
import {
  aliasToCountryId,
  countriesByContinent,
  countriesById,
  quizCountries,
  totalCountryCount,
} from './quiz-data'
import { createGlobe, type GlobeFlightStatus } from './globe'

registerSW({ immediate: true })

const STARTING_COUNTRY_ID = 'GBR'
const MOBILE_CHEAT_HOLD_MS = 2000

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)

  if (!element) {
    throw new Error(`Required element missing: ${selector}`)
  }

  return element
}

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('App root not found')
}

app.innerHTML = `
  <main class="shell">
    <section class="hero">
      <div class="hero__copy">
        <h1>Can you name all 197 countries of the world?</h1>
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
            <label class="answer-panel__label" for="guess-input">Enter a country</label>
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
            placeholder="Start typing a country name..."
          />
          <p id="status" class="status" aria-live="polite"></p>
        </div>
      </div>
      <section class="flight-panel hero__flight-panel" aria-live="polite">
        <p class="flight-panel__eyebrow">Flight Path</p>
        <strong id="flight-route" class="flight-panel__route">Plane standing by in the United Kingdom</strong>
        <span id="flight-distance" class="flight-panel__meta">Leg distance: 0 miles</span>
        <span id="flight-total" class="flight-panel__meta">Total distance flown: 0 miles</span>
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
const flightRouteElement = requireElement<HTMLElement>('#flight-route')
const flightDistanceElement = requireElement<HTMLElement>('#flight-distance')
const flightTotalElement = requireElement<HTMLElement>('#flight-total')
const continentBoard = requireElement<HTMLElement>('#continent-board')
const zoomInButton = requireElement<HTMLButtonElement>('#zoom-in')
const zoomOutButton = requireElement<HTMLButtonElement>('#zoom-out')
const globeContainer = requireElement<HTMLElement>('#globe')
const giveUpButton = requireElement<HTMLButtonElement>('#give-up-button')
const compactGiveUpButton = requireElement<HTMLButtonElement>('#give-up-button-compact')

const answeredIds = new Set<string>([STARTING_COUNTRY_ID])
const cheatedIds = new Set<string>()
const answerOrder: string[] = []
let quizStartedAt: number | null = null
let statusTone: 'neutral' | 'success' | 'muted' = 'neutral'
let intervalHandle = window.setInterval(tick, 250)
let quizFinished = false
let globe: Awaited<ReturnType<typeof createGlobe>> | null = null
const trackerSlotByCountryId = new Map<string, HTMLLIElement>()
const trackerSolvedCountByContinent = new Map<string, HTMLElement>()

function attachTrackerCheatInteractions(
  slot: HTMLLIElement,
  countryId: string,
): void {
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
  previewLabel.textContent = country.name

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
  name.textContent = country.name

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
      slot.className = 'country-slot country-slot--empty'
      slot.style.setProperty('--chars', String(Math.max(6, country.name.length)))
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

function renderFlightStatus(status: GlobeFlightStatus | null): void {
  if (!status) {
    flightRouteElement.textContent = 'Plane standing by in the United Kingdom'
    flightDistanceElement.textContent = 'Leg distance: 0 miles'
    flightTotalElement.textContent = 'Total distance flown: 0 miles'
    return
  }

  flightRouteElement.textContent = `${status.fromName} to ${status.toName}`
  flightDistanceElement.textContent = `Leg distance: ${formatMiles(status.legMiles)}`
  flightTotalElement.textContent = `Total distance flown: ${formatMiles(status.totalMiles)}`
}

function syncSolvedCountries(options?: { focusLatest?: boolean }): void {
  globe?.setAnswered(answeredIds, {
    cheatedIds,
    focusLatest: options?.focusLatest,
  })
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
  statusTone = 'muted'
  renderStatus(message)
  const finalTimerText = options?.timerText ?? '00:00'
  timerElement.textContent = finalTimerText
  compactTimerElement.textContent = finalTimerText
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

  answerInput.value = ''
  syncSolvedCountries()
  globe?.syncFlightPath([], { animate: false })
  globe?.resetView()
  renderFlightStatus(null)
  renderScore()
  renderTracker()

  const elapsedTimeText = formatTime(elapsedMilliseconds())
  const countryNoun = remainingCountryIds.length === 1 ? 'country' : 'countries'
  finishQuiz(
    `Gave up at ${solvedBeforeGiveUp}/${totalCountryCount}. Revealed ${remainingCountryIds.length} remaining ${countryNoun}.`,
    {
      timerText: elapsedTimeText,
    },
  )
}

function solveCountry(
  countryId: string,
  source: 'answer' | 'cheat' = 'answer',
): void {
  const country = countriesById.get(countryId)

  if (!country || answeredIds.has(countryId) || quizFinished) {
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
  answerOrder.push(countryId)
  answerInput.value = ''
  syncSolvedCountries()
  renderFlightStatus(globe?.syncFlightPath(answerOrder, { animate: true }) ?? null)
  renderScore()
  updateTracker(countryId)

  if (answeredIds.size === totalCountryCount) {
    const elapsedTimeText = formatTime(elapsedMilliseconds())
    finishQuiz(`All 197 countries solved in ${elapsedTimeText}.`, {
      timerText: elapsedTimeText,
    })
    return
  }

  statusTone = source === 'cheat' ? 'neutral' : 'success'
  renderStatus(
    source === 'cheat'
      ? `${country.name} revealed via cheat.`
      : `${country.name} accepted.`,
  )
}

function maybeAcceptGuess(): void {
  const normalizedGuess = normalizeAnswer(answerInput.value)

  if (!normalizedGuess || quizFinished) {
    return
  }

  const matchedCountryId = aliasToCountryId.get(normalizedGuess)

  if (!matchedCountryId) {
    return
  }

  if (answeredIds.has(matchedCountryId)) {
    return
  }

  solveCountry(matchedCountryId)
}

function submitGuess(): void {
  const normalizedGuess = normalizeAnswer(answerInput.value)

  if (!normalizedGuess || quizFinished) {
    return
  }

  const matchedCountryId = aliasToCountryId.get(normalizedGuess)

  if (!matchedCountryId) {
    return
  }

  if (answeredIds.has(matchedCountryId)) {
    statusTone = 'muted'
    renderStatus(`${countriesById.get(matchedCountryId)?.name ?? 'That country'} is already solved.`)
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

renderScore()
renderTracker()
renderFlightStatus(null)
tick()
answerInput.focus()

globe = await createGlobe(globeContainer, quizCountries, {
  onCountryCheat(countryId) {
    solveCountry(countryId, 'cheat')
  },
})
syncSolvedCountries({ focusLatest: true })
renderFlightStatus(globe.syncFlightPath(answerOrder, { animate: false }))
