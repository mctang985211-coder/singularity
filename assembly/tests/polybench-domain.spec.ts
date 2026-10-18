import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { confinedArgv } from '../src/bubble.ts'
import { loadDomain } from '../src/domain.ts'

const DIR = fileURLToPath(new URL('../../deployment/domain/polybench', import.meta.url))
const execute = promisify(execFile)
const reference = await readFile(join(DIR, 'reference.c'), 'utf8')

it('loads a CPU kernel and fixed evaluator without prescribing candidate solutions or decomposition', async () => {
  const domain = await loadDomain(DIR, async () => { throw new Error('declaration loading ran a process') })
  expect([...domain.templates.keys()]).toEqual(['polybench-3mm'])
  const template = domain.templates.get(domain.rootTemplate!)!
  expect(template.initial!.bytes).toEqual(domain.inputs.find(input => input.ref === 'reference')!.bytes)
  expect(template.decomposition).toBeUndefined()
  expect(template.guidance).toBeUndefined()
  expect(template.checks).toEqual([])
  expect(domain.verifiers).toEqual([])
  expect(domain.measurement).toBeUndefined()
  expect(domain.inputs.map(input => input.ref)).toEqual(['reference', 'benchmark'])
})

it('compiles and checks a four-thread candidate inside a Bubble with protected evaluation inputs', async () => {
  const work = await mkdtemp(join(tmpdir(), 'polybench-bubble-'))
  try {
    await mkdir(join(work, 'inputs'))
    for (const file of ['benchmark.py', 'reference.c'])
      await writeFile(join(work, 'inputs', file), await readFile(join(DIR, file)))
    // A fixture for the evaluator, never supplied as a domain input or initial solution.
    await writeFile(join(work, 'kernel.c'), reference.replaceAll('  for (i =',
      '  #pragma omp parallel for private(j,k)\n  for (i ='))
    const argv = confinedArgv(['/usr/bin/python3', 'inputs/benchmark.py', 'kernel.c'], {
      root: work, writable: true, protected: [join(work, 'inputs')], references: [DIR],
    })
    const { stdout } = await execute(argv[0]!, argv.slice(1), {
      env: { ...process.env, POLYBENCH_LOCK: join(DIR, 'reference.c') }, timeout: 30_000,
    })
    const report = JSON.parse(stdout)
    expect(report.correct).toBe(true)
    expect(report.checked_shapes).toHaveLength(4)
    expect(report.threads).toBe(4)
    expect(report.cpus).toHaveLength(4)
    expect(report.worker_cpu_affinities).toHaveLength(4)
    for (const affinity of report.worker_cpu_affinities)
      for (const cpu of affinity) expect(report.cpus).toContain(cpu)
    expect(report.baseline_samples).toHaveLength(7)
    expect(report.candidate_samples).toHaveLength(7)
    expect(report.evaluation_seconds).toBeGreaterThan(report.candidate_seconds)
    expect(typeof report.meets_target).toBe('boolean')
  } finally { await rm(work, { recursive: true, force: true }) }
}, 35_000)

it('rejects wrong output, input mutation and invalid source with useful compiler diagnostics', async () => {
  const work = await mkdtemp(join(tmpdir(), 'polybench-invalid-'))
  try {
    for (const [source, error] of [
      [reference.replace('G[i][j] = 0.0;', 'G[i][j] = 1.0;'), 'incorrect G'],
      [reference.replace('  int i, j, k;', '  int i, j, k;\n  ((double *)A)[0] = 12345.0;'), 'modified an input'],
      ['this is not C;', 'candidate compilation failed:'],
    ]) {
      const candidate = join(work, 'kernel.c')
      await writeFile(candidate, source!)
      await expect(execute('/usr/bin/python3', [join(DIR, 'benchmark.py'), candidate], { timeout: 30_000 }))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(error!) })
    }
  } finally { await rm(work, { recursive: true, force: true }) }
}, 35_000)

it('keeps the numerical and performance verdicts separate for an unchanged reference', async () => {
  const { stdout } = await execute('/usr/bin/python3', [join(DIR, 'benchmark.py'), join(DIR, 'reference.c'), '--threads', '1'],
    { timeout: 30_000 })
  const report = JSON.parse(stdout)
  expect(report.correct).toBe(true)
  expect(report.threads).toBe(1)
  expect(report.cpus).toHaveLength(1)
  expect(report.meets_target).toBe(report.speedup >= 1.20)
  await expect(execute('/usr/bin/python3', [join(DIR, 'benchmark.py'), join(DIR, 'reference.c'), '--threads', '5']))
    .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('invalid choice') })
}, 35_000)
