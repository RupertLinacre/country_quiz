import { spawn } from 'node:child_process'

// Deliberately sequential: overlapping browser workloads invalidate FPS results.
// MATRIX=slow|fast|dense|solved|all node scripts/benchmark-render-experiments.mjs
const group = process.env.MATRIX ?? 'slow'
const slowVariants = ['svg-standard', 'canvas-100', 'canvas-75', 'canvas-50', 'svg-coarse', 'svg-islands', 'svg-adaptive']
const jobs = {
  slow: slowVariants.map(variant => ({ variant, rate: 6, repeats: 3, dpr: 2, solved: 0 })),
  fast: ['svg-standard', 'svg-full', 'svg-adaptive'].map(variant => ({ variant, rate: 1, repeats: 2, dpr: 2, solved: 0 })),
  dense: ['svg-standard', 'canvas-100', 'canvas-50'].map(variant => ({ variant, rate: 6, repeats: 2, dpr: 3, solved: 0 })),
  solved: ['svg-standard', 'svg-adaptive'].map(variant => ({ variant, rate: 6, repeats: 2, dpr: 2, solved: 100 })),
}
const selected = group === 'all' ? Object.entries(jobs) : [[group, jobs[group]]]
if (selected.some(([, jobs]) => !jobs)) throw new Error(`Unknown matrix: ${group}`)
for (const [groupName, jobs] of selected) {
  for (const { variant, rate, repeats, dpr, solved } of jobs) {
    const name = `experiment-${groupName}-${variant}`
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/benchmark-flights.mjs', 'dist', name, String(rate), String(repeats), 'mobile'], {
        stdio: 'inherit',
        env: { ...process.env, ROUTES: 'GBR,USA,CHN,USA,AUS,GBR', QUERY: `?renderExperiment=${variant}`, DPR: String(dpr), SOLVED_COUNT: String(solved) },
      })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)))
    })
  }
}
