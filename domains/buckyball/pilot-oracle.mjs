import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const records = []
const digest = text => createHash('sha256').update(text).digest('hex')
class InfrastructureError extends Error {}
async function execute(argv, label) {
  const result = await new Promise(resolve => execFile(argv[0], argv.slice(1), {
    cwd: process.cwd(), timeout: 12_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, HOME: process.cwd(), TMPDIR: process.cwd() },
  }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
    stdout, stderr, ...(error !== null && typeof error.code !== 'number' ? { failure: error.message } : {}) })))
  records.push({ label, argv, ...result })
  if (result.code === null) throw new InfrastructureError(`${label}: ${result.failure}`)
  return result
}
function frame(text) {
  const match = /(?:^|\n)BB_PILOT_RESULT\r?\n([\s\S]*?)\r?\nBB_PILOT_END(?:\r?\n|$)/.exec(text)
  if (!match || text.indexOf('BB_PILOT_RESULT', match.index + match[0].length) !== -1) return null
  const values = match[1].trim().split(/\r?\n/)
  return values.every(value => /^-?\d+$/.test(value)) ? values.join('\n') : null
}
try {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
  if (config.version !== 1 || !config.bemuArgv?.length || !config.includes?.length || !config.expectedFuncts?.length) throw new InfrastructureError('Incomplete oracle configuration')
  const build = join(process.cwd(), '.pilot-check')
  await mkdir(build)
  const candidate = join(process.cwd(), config.target), object = join(build, 'candidate.o')
  const includes = config.includes.flatMap(path => ['-I', path.startsWith('/') ? path : join(process.cwd(), path)])
  const compiled = await execute([config.riscvGcc, '-O2', '-march=rv64gc', '-mabi=lp64d', '-static', ...includes,
    '-c', candidate, '-o', object], 'compile-candidate')
  if (compiled.code !== 0) process.exitCode = 1
  else {
    for (const seed of config.seeds) {
      const elf = join(build, `candidate-${seed}.elf`), reference = join(build, `scalar-${seed}`)
      const define = `-DBB_PILOT_SEED=${seed}`
      const linked = await execute([config.riscvGcc, '-O2', '-march=rv64gc', '-mabi=lp64d', '-static', ...includes,
        define, object, config.harness, join(process.cwd(), 'stack/runtime/src/dma.c'), '-o', elf], `link-candidate-${seed}`)
      if (linked.code !== 0) { process.exitCode = 1; break }
      const scalar = await execute([config.hostCompiler, '-O2', '-std=c11', define, config.reference, '-o', reference], `compile-independent-scalar-${seed}`)
      if (scalar.code !== 0) throw new InfrastructureError('Independent scalar oracle failed to compile')
      const log = join(build, `bemu-${seed}`)
      await mkdir(log)
      const expected = await execute([reference], `scalar-${seed}`)
      if (expected.code !== 0 || frame(expected.stdout) === null) throw new InfrastructureError('Independent scalar oracle did not produce a complete result')
      const values = { elf, log, seed: String(seed), trial: process.cwd() }
      const actual = await execute(config.bemuArgv.map(arg => arg.replace(/\{(elf|log|seed|trial)\}/g, (_, key) => values[key])), `bemu-${seed}`)
      const wanted = frame(expected.stdout), observed = frame(actual.stdout)
      let trace = ''
      try { trace = await readFile(join(log, 'bdb.ndjson'), 'utf8') } catch {}
      const executed = new Set(trace.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(event => event.type === 'itrace' && event.event === 'complete').map(event => Number(event.funct)))
      const isaPass = config.expectedFuncts.every(funct => executed.has(funct))
      const pass = actual.code === 0 && wanted === observed && isaPass
      records.push({ label: `compare-${seed}`, pass, expectedDigest: digest(wanted),
        observedDigest: observed === null ? null : digest(observed), isaPass, expectedFuncts: config.expectedFuncts,
        executedFuncts: [...executed], traceDigest: digest(trace), evidenceScope: 'BEMU functional semantics and completed ISA trace only' })
      if (!pass) { process.exitCode = 1; break }
    }
  }
  process.exitCode ??= 0
} catch (error) {
  records.push({ error: String(error) })
  process.exitCode = 4
}
console.log(JSON.stringify({ version: 1, verdict: process.exitCode === 0 ? 'pass' : process.exitCode === 1 ? 'fail' : 'unknown', records }))
