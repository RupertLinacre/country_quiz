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
        <p class="eyebrow">Countries of the World</p>
        <h1>Spin the globe and name all 197 countries before the clock runs out.</h1>
        <p class="hero__lede">
          Correct answers register instantly. Solved countries light up on the globe and fill
          into the continent tracker below.
        </p>
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
          <p class="answer-panel__hint">Drag to spin. Scroll or use the zoom buttons to inspect tight regions.</p>
          <p id="status" class="status" aria-live="polite">The timer starts now.</p>
        </div>
      </div>
      <div class="globe-card">
        <div class="globe-card__toolbar">
          <div>
            <p class="globe-card__title">Solved countries appear in gold</p>
            <p class="globe-card__subtitle">Labels only show on the visible side of the globe.</p>
          </div>
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
        <div>
          <p class="eyebrow">Continent Tracker</p>
          <h2>Every answer fills its slot immediately.</h2>
        </div>
        <p class="tracker__summary">
          The accepted-answer list is separate from the geometry, so future solved-state styles can switch from color fills to flag fills without reworking the quiz logic.
        </p>
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
              ${solved ? `<span>${country.name}</span>` : ''}
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
  renderScore()
  renderTracker()

  if (answeredIds.size === totalCountryCount) {
    finishQuiz('All 197 countries found. The globe is complete.')
    return
  }

  statusTone = 'success'
  renderStatus(`${country.name} accepted.`)
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
  const normalizedGuess = normalizeAnswer(answerInput.value)

  if (!normalizedGuess || quizFinished) {
    return
  }

  const matchedCountryId = aliasToCountryId.get(normalizedGuess)

  if (!matchedCountryId) {
    return
  }

  if (answeredIds.has(matchedCountryId)) {
    answerInput.value = ''
    statusTone = 'muted'
    renderStatus(`${countriesById.get(matchedCountryId)?.name ?? 'That country'} is already solved.`)
    return
  }

  solveCountry(matchedCountryId)
})

zoomInButton.addEventListener('click', () => globe?.zoomBy(1.14))
zoomOutButton.addEventListener('click', () => globe?.zoomBy(0.88))

renderScore()
renderTracker()
tick()
answerInput.focus()

globe = await createGlobe(globeContainer, quizCountries)
globe.setAnswered(answeredIds)
