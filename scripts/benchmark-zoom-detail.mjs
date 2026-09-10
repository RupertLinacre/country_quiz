import { spawn } from 'node:child_process'

// Use one production build and keep benchmark processes sequential.
const group = process.env.MATRIX ?? 'slow'
const jobs = {
  slow: ['svg-standard', 'svg-zoom-standard-1', 'svg-zoom-standard-2'].map(variant => ({ variant, rate: 6, repeats: 3 })),
  overview: ['svg-standard', 'svg-zoom-standard-1'].map(variant => ({ variant, rate: 6, repeats: 2, overview: true })),
  solved: ['svg-standard', 'svg-zoom-standard-1'].map(variant => ({ variant, rate: 6, repeats: 2, solved: 100 })),
  fast: ['svg-standard', 'svg-zoom-standard-1'].map(variant => ({ variant, rate: 1, repeats: 2 })),
  confirmation: ['svg-zoom-standard-1', 'svg-standard'].map(variant => ({ variant, rate: 6, repeats: 3 })),
  adaptiveSlow: [{ variant: 'svg-zoom-adaptive', rate: 6, repeats: 2 }],
  adaptiveFast: [{ variant: 'svg-zoom-adaptive', rate: 1, repeats: 2 }],
}
const selected = group === 'all' ? Object.entries(jobs) : [[group, jobs[group]]]
if (selected.some(([, jobs]) => !jobs)) throw new Error(`Unknown matrix: ${group}`)
for (const [name, jobs] of selected) for (const { variant, rate, repeats, overview, solved = 0 } of jobs) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/benchmark-flights.mjs', 'dist', `zoom-${name}-${variant}`, String(rate), String(repeats), 'mobile'], {
      stdio: 'inherit', env: { ...process.env, QUERY: `?renderExperiment=${variant}`, ROUTES: 'GBR,USA,CHN,USA,AUS,GBR', DPR: '2', SOLVED_COUNT: String(solved), START_OVERVIEW: overview ? '1' : '' },
    })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${variant} exited ${code}`)))
  })
}
