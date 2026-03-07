import './style.css'

import { normalizeAnswer } from './normalize'
import {
  aliasToCountryId,
  countriesByContinent,
  countriesById,
  quizCountries,
  totalCountryCount,
} from './quiz-data'
import { createGlobe } from './globe'

const QUIZ_DURATION_MS = 15 * 60 * 1000

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
            <span class="stat-card__label">Time Left</span>
            <strong id="timer" class="stat-card__value">15:00</strong>
            <span id="remaining" class="stat-card__meta">${totalCountryCount} left</span>
          </article>
        </div>
        <div class="answer-panel">
          <label class="answer-panel__label" for="country-input">Enter a country</label>
          <input
            id="country-input"
            class="answer-panel__input"
            type="text"
            autocomplete="off"
            autocapitalize="words"
            spellcheck="false"
            placeholder="Start typing a country name..."
          />
          <p id="status" class="status" aria-live="polite"></p>
        </div>
      </div>
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
const timerElement = requireElement<HTMLElement>('#timer')
const remainingElement = requireElement<HTMLElement>('#remaining')
const statusElement = requireElement<HTMLElement>('#status')
const answerInput = requireElement<HTMLInputElement>('#country-input')
const continentBoard = requireElement<HTMLElement>('#continent-board')
const zoomInButton = requireElement<HTMLButtonElement>('#zoom-in')
const zoomOutButton = requireElement<HTMLButtonElement>('#zoom-out')
const globeContainer = requireElement<HTMLElement>('#globe')

const answeredIds = new Set<string>()
const deadline = Date.now() + QUIZ_DURATION_MS
let statusTone: 'neutral' | 'success' | 'muted' = 'neutral'
let intervalHandle = window.setInterval(tick, 250)
let quizFinished = false
let globe: Awaited<ReturnType<typeof createGlobe>> | null = null

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function solvedFlagMarkup(countryId: string): string {
  const country = countriesById.get(countryId)

  if (!country || country.appearance.kind !== 'flag') {
    return ''
  }

  const safeName = escapeHtml(country.name)
  const safeAssetUrl = escapeHtml(country.appearance.assetUrl)

  return `
    <span class="country-slot__flag-anchor" aria-hidden="true">
      <img class="country-slot__flag-icon" src="${safeAssetUrl}" alt="" loading="lazy" />
      <span class="country-slot__flag-preview">
        <img class="country-slot__flag-preview-image" src="${safeAssetUrl}" alt="" loading="lazy" />
        <span class="country-slot__flag-preview-label">${safeName}</span>
      </span>
    </span>
  `
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function solvedCountByContinent(continent: string): number {
  return countriesByContinent
    .find((entry) => entry.continent === continent)
    ?.countries.filter((country) => answeredIds.has(country.id)).length ?? 0
}

function renderTracker(): void {
  continentBoard.innerHTML = countriesByContinent
    .map(({ continent, countries }) => {
      const solvedCount = solvedCountByContinent(continent)
      const slots = countries
        .map((country) => {
          const solved = answeredIds.has(country.id)

          return `
            <li
              class="country-slot ${solved ? 'country-slot--solved' : 'country-slot--empty'}"
              style="--chars:${Math.max(6, country.name.length)}"
            >
              ${
                solved
                  ? `${solvedFlagMarkup(country.id)}<span class="country-slot__name">${escapeHtml(country.name)}</span>`
                  : ''
              }
            </li>
          `
        })
        .join('')

      return `
        <section class="continent-section">
          <div class="continent-section__header">
            <h3>${continent}</h3>
            <span>${solvedCount}/${countries.length}</span>
          </div>
          <ul class="continent-section__list">
            ${slots}
          </ul>
        </section>
      `
    })
    .join('')
}

function renderScore(): void {
  scoreElement.textContent = `${answeredIds.size}/${totalCountryCount} countries`
  remainingElement.textContent = `${totalCountryCount - answeredIds.size} left`
}

function renderStatus(message: string): void {
  statusElement.textContent = message
  statusElement.dataset.tone = statusTone
}

function finishQuiz(message: string): void {
  if (quizFinished) {
    return
  }

  quizFinished = true
  window.clearInterval(intervalHandle)
  answerInput.disabled = true
  statusTone = 'muted'
  renderStatus(message)
  timerElement.textContent = '00:00'
}

function solveCountry(countryId: string): void {
  const country = countriesById.get(countryId)

  if (!country || answeredIds.has(countryId) || quizFinished) {
    return
  }

  answeredIds.add(countryId)
  answerInput.value = ''
  globe?.setAnswered(answeredIds)
  globe?.focusCountry(countryId)
  renderScore()
  renderTracker()

  if (answeredIds.size === totalCountryCount) {
    finishQuiz('All 197 countries found. The globe is complete.')
    return
  }

  statusTone = 'success'
  renderStatus(`${country.name} accepted.`)
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

  const remainingMilliseconds = deadline - Date.now()
  timerElement.textContent = formatTime(remainingMilliseconds)

  if (remainingMilliseconds <= 0) {
    finishQuiz(`Time is up. You found ${answeredIds.size} of ${totalCountryCount} countries.`)
  }
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

renderScore()
renderTracker()
tick()
answerInput.focus()

globe = await createGlobe(globeContainer, quizCountries)
globe.setAnswered(answeredIds)
