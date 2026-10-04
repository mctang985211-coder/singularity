/**
 * Shared fixtures for the log-analytics validation specs: the protected input
 * cases, the independent checker source, the Task template library (including a
 * deliberately defective aggregate version) and the real file/shell tools both
 * specs mount.
 *
 * @module tests/support/log-pipeline
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineTool } from '../../../../thirdparty/deepseek-harness/packages/core/tools/lib/index.js'
import type { CriterionSpec, TaskTemplate, TaskTemplateRef } from '../../task/src/index.ts'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'
export interface LogEvent {
  readonly ts: string
  readonly level: LogLevel
  readonly message: string
}
export interface LogCase {
  readonly name: string
  readonly log: string
}
export interface LogExpectation {
  readonly events: readonly LogEvent[]
  readonly stats: { readonly total: number; readonly perLevel: Readonly<Record<LogLevel, number>>; readonly errorRate: number }
  readonly reportLines: readonly string[]
}

/** Case 1: 12 lines, 6 INFO / 3 WARN / 3 ERROR, error rate 0.25 exactly. */
export const CASE_1 = [
  '2026-10-03T08:00:01Z INFO service started on port 8080',
  '2026-10-03T08:00:02Z INFO loaded 42 configuration keys',
  '2026-10-03T08:00:03Z ERROR database connection refused after 3 retries',
  '2026-10-03T08:00:04Z WARN cache directory is missing, using defaults',
  '2026-10-03T08:00:05Z INFO request GET /health completed in 12ms',
  '2026-10-03T08:00:06Z ERROR upstream timeout while calling billing API',
  '2026-10-03T08:00:07Z INFO request POST /orders completed in 87ms',
  '2026-10-03T08:00:08Z WARN retrying upstream call, attempt 2 of 5',
  '2026-10-03T08:00:09Z ERROR failed to write audit record: permission denied',
  '2026-10-03T08:00:10Z INFO background compaction finished, freed 512 MB',
  '2026-10-03T08:00:11Z WARN disk usage at 91 percent on volume data',
  '2026-10-03T08:00:12Z INFO graceful shutdown complete',
].join('\n') + '\n'

/** Case 2: a different 8-line input, 4 INFO / 2 WARN / 2 ERROR, error rate 0.25 exactly. */
export const CASE_2 = [
  '2026-10-04T09:14:02Z INFO worker pool warmup finished',
  '2026-10-04T09:14:03Z WARN clock skew of 120ms detected on node 3',
  '2026-10-04T09:14:04Z INFO consumed 18 messages from queue orders',
  '2026-10-04T09:14:05Z ERROR payment retry budget exhausted for order 4471',
  '2026-10-04T09:14:06Z INFO schema migration 2026_10 applied',
  '2026-10-04T09:14:07Z ERROR unable to reach replica db-2: connection reset',
  '2026-10-04T09:14:08Z INFO metrics flushed to collector',
  '2026-10-04T09:14:09Z WARN request queue depth above threshold: 812 items',
].join('\n') + '\n'

export const CASES: readonly LogCase[] = [
  { name: 'case-1', log: CASE_1 },
  { name: 'case-2', log: CASE_2 },
]

/** Parse one log the way the independent checker does, in the spec's own code. */
export function parseEventsLog(log: string): LogEvent[] {
  return log
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line, index) => {
      const match = /^(\S+) (INFO|WARN|ERROR) (.+)$/.exec(line)
      if (match === null) throw new Error(`log line ${index + 1} does not match "<ISO8601-ts> <LEVEL> <message>": ${line}`)
      return { ts: match[1]!, level: match[2] as LogLevel, message: match[3]! }
    })
}

/** Every expected value of one input case, recomputed here — never hard-coded per case. */
export function expectedLog(log: string): LogExpectation {
  const events = parseEventsLog(log)
  const perLevel: Record<LogLevel, number> = { INFO: 0, WARN: 0, ERROR: 0 }
  for (const event of events) perLevel[event.level] += 1
  const total = events.length
  const errorRate = Number((perLevel.ERROR / total).toFixed(3))
  return {
    events,
    stats: { total, perLevel, errorRate },
    reportLines: [
      '# Log Report',
      `Total: ${total}`,
      `INFO: ${perLevel.INFO}`,
      `WARN: ${perLevel.WARN}`,
      `ERROR: ${perLevel.ERROR}`,
      `Error rate: ${errorRate}`,
    ],
  }
}

/**
 * The independent acceptance checker the test authors into the checkout. It
 * recomputes every expectation from `events.log` with its own parsing logic (it
 * never imports the delivered modules) and exits non-zero on any mismatch.
 * Stages: `parse`, `aggregate`, `report`, `pipeline`, `cli`, `all`.
 */
export const CHECKER = String.raw`import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const LOG = 'events.log'
const lines = readFileSync(LOG, 'utf8').split('\n').filter(line => line.trim() !== '')
const events = lines.map((line, index) => {
  const match = /^(\S+) (INFO|WARN|ERROR) (.+)$/.exec(line)
  if (match === null) throw new Error('events.log line ' + (index + 1) + ' does not match "<ISO8601-ts> <LEVEL> <message>": ' + JSON.stringify(line))
  return { ts: match[1], level: match[2], message: match[3] }
})
const total = events.length
const perLevel = { INFO: 0, WARN: 0, ERROR: 0 }
for (const event of events) perLevel[event.level] += 1
const errorRate = Number((perLevel.ERROR / total).toFixed(3))
const expectedStats = { total: total, perLevel: perLevel, errorRate: errorRate }
const expectedReport = ['# Log Report', 'Total: ' + total, 'INFO: ' + perLevel.INFO, 'WARN: ' + perLevel.WARN,
  'ERROR: ' + perLevel.ERROR, 'Error rate: ' + errorRate]

function readJson(path) {
  if (!existsSync(path)) throw new Error('missing artifact ' + path)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function script(name) {
  if (!existsSync(name)) throw new Error('missing deliverable ' + name + ' in the checkout root')
}

function checkParse(dir) {
  script('parse.mjs')
  assert.deepEqual(readJson(join(dir, 'events.json')), events,
    'events.json does not match the events parsed independently from events.log')
}

function checkAggregate(dir) {
  script('aggregate.mjs')
  assert.deepEqual(readJson(join(dir, 'stats.json')), expectedStats,
    'stats.json does not match the statistics recomputed independently from events.log')
}

function checkReport(dir) {
  script('report.mjs')
  const stats = join(dir, 'stats.json')
  if (!existsSync(stats)) throw new Error('missing upstream artifact ' + stats + ': report needs verified aggregation output')
  const path = join(dir, 'report.md')
  if (!existsSync(path)) throw new Error('missing artifact ' + path)
  const present = new Set(readFileSync(path, 'utf8').split('\n').map(line => line.trim()))
  for (const line of expectedReport) assert.ok(present.has(line), 'report.md is missing the required line ' + JSON.stringify(line))
}

function checkPipeline(dir) {
  checkParse(dir)
  checkAggregate(dir)
  checkReport(dir)
}

function checkCli() {
  script('cli.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'log-analytics-cli-')) + '/'
  execFileSync(process.execPath, ['cli.mjs', LOG, dir], { cwd: process.cwd(), stdio: 'pipe' })
  checkPipeline(dir)
}

const stage = process.argv[2]
if (stage === 'parse') checkParse('out')
else if (stage === 'aggregate') checkAggregate('out')
else if (stage === 'report') checkReport('out')
else if (stage === 'pipeline') checkPipeline('out')
else if (stage === 'cli') checkCli()
else if (stage === 'all') { checkPipeline('out'); checkCli() }
else throw new Error('unknown stage ' + JSON.stringify(stage) + '; expected parse, aggregate, report, pipeline, cli or all')
console.log(stage + ' verified')
`

/** The protected paths every stage criterion declares. */
export const PROTECTED_INPUTS = ['checks/verify.mjs', 'events.log'] as const

/** One criterion: the named stage of the independent checker, over the protected inputs. */
export function stageCriteria(stage: string): CriterionSpec[] {
  return [{
    criterionId: `${stage}-result`,
    description: `${stage} agrees with the original protected input`,
    command: `node checks/verify.mjs ${stage}`,
    verifierRef: 'command',
    protectedInputs: [...PROTECTED_INPUTS],
  }]
}

export const LOG_CONSTRAINTS = ['Keep events.log and checks/verify.mjs unchanged. Read and write only inside the checkout.']

export const LOG_CATALOG = ['logs']

function leaf(options: { id: string; appliesTo: string; objective: string; stage: string; catalogPath?: string[]; version?: number }): TaskTemplate {
  return {
    id: options.id,
    version: options.version ?? 1,
    catalogPath: options.catalogPath ?? [...LOG_CATALOG],
    appliesTo: [options.appliesTo],
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
    contract: {
      objective: options.objective,
      acceptanceCriteria: stageCriteria(options.stage),
      requiredCapabilities: ['local-files'],
      constraints: LOG_CONSTRAINTS,
    },
  }
}

export function parseTemplate(): TaskTemplate {
  return leaf({
    id: 'parse-log-events',
    appliesTo: 'Turn events.log into out/events.json with the per-line event records.',
    objective: 'Author parse.mjs in the checkout root so that `node parse.mjs events.log` reads events.log (one event per line, format ' +
      '"<ISO8601-ts> <LEVEL> <message>") and writes out/events.json: a JSON array of {ts, level, message} objects, one per input ' +
      'line, in input order with each message copied verbatim. Run the script so out/events.json exists.',
    stage: 'parse',
  })
}

/**
 * The aggregate template. The repaired contract asks for `perLevel`, which is what
 * the fixed checker requires; the deliberately defective v1 instead names a
 * `byLevel` field while keeping the same, correct acceptance criterion — an
 * internally inconsistent template a worker can follow and still fail.
 */
export function aggregateTemplate(options: { defective?: boolean; version?: number } = {}): TaskTemplate {
  const field = options.defective === true ? 'byLevel' : 'perLevel'
  return leaf({
    id: 'aggregate-event-stats',
    version: options.version ?? 1,
    appliesTo: 'Compute out/stats.json from out/events.json.',
    objective: 'Author aggregate.mjs in the checkout root so that `node aggregate.mjs` reads out/events.json and writes out/stats.json with ' +
      `exactly the shape {total, ${field}: {INFO, WARN, ERROR}, errorRate}: total is the number of events, ${field} counts each ` +
      'level, and errorRate is ERROR/total rounded to exactly 3 decimals. Run the script so out/stats.json exists.',
    stage: 'aggregate',
  })
}

export function reportTemplate(options: { honestLeaf?: boolean } = {}): TaskTemplate {
  const authoring =
    'Author report.mjs in the checkout root so that `node report.mjs` reads out/stats.json and writes out/report.md. The file must ' +
    'contain exactly these lines (extra lines are allowed): "# Log Report", "Total: <total>", "INFO: <info>", "WARN: <warn>", ' +
    '"ERROR: <error>", "Error rate: <errorRate>". Run the script so out/report.md exists.'
  // The honest replay leaf: compliance must be cheap, so the freshness check comes FIRST and the gap path is one submission.
  const honesty =
    options.honestLeaf === true
      ? 'FIRST, before anything else, check that your input is fresh: run `test -f out/stats.json && test -f out/events.json && test ' +
        'out/stats.json -nt out/events.json`. out/stats.json must be NEWER than out/events.json, which means the aggregation stage of THIS ' +
        "run wrote it after this run's parse stage. If out/stats.json is missing or NOT newer than out/events.json, it is stale: do NOT " +
        'explore the repository, read other tasks or sessions, poll, wait, retry, substitute, fabricate or regenerate anything, and do NOT ' +
        'author report.mjs — immediately call task_submit_result with a one-line gap report naming the missing or stale artifact. The ' +
        'criterion will fail it, and that is the intended honest outcome. Your only input is the verified out/stats.json produced by this ' +
        "run's upstream aggregation stage; do not read out/events.json or any other artifact to derive the numbers. If the freshness check " +
        'passes, then: '
      : ''
  return leaf({
    id: 'render-stats-report',
    appliesTo: 'Render out/report.md from out/stats.json.',
    objective: honesty + authoring,
    stage: 'report',
  })
}

/** One distractor in the `web` catalog, carrying the marker string the live assertions forbid in any request. */
export function unrelatedTemplate(index: number): TaskTemplate {
  return {
    ...leaf({ id: `unrelated-${index}`, appliesTo: 'UNRELATED_DOMAIN_MARKER: paint a webpage.', objective: 'UNRELATED_DOMAIN_MARKER: paint a webpage.', stage: 'parse', catalogPath: ['web'] }),
  }
}

/** The coordinating template: one owned responsibility whose recipe composes the three stage templates in dependency order. */
export function pipelineTemplate(refs: { parse: TaskTemplateRef; aggregate: TaskTemplateRef; report: TaskTemplateRef }): TaskTemplate {
  return {
    id: 'log-analytics-pipeline', version: 1, catalogPath: [...LOG_CATALOG],
    appliesTo: ['Own and independently verify the parse, aggregate and report stages of the log-analytics pipeline.'],
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
    contract: {
      objective: 'Own the log-analytics pipeline: parse.mjs, aggregate.mjs and report.mjs must exist in the checkout root and ' +
        'running them in order (`node parse.mjs events.log`, `node aggregate.mjs`, `node report.mjs`) must produce out/events.json, ' +
        'out/stats.json and out/report.md accepted by the independent checker. Coordinate the three stages as independently verified ' +
        'children, respect their data dependency order, and reuse the available stage templates where applicable.',
      acceptanceCriteria: stageCriteria('pipeline'),
      requiredCapabilities: ['coordinate-tasks'],
      constraints: LOG_CONSTRAINTS,
    },
    decomposition: {
      reason: 'The three stages have independently checkable artifacts and a strict data dependency order.',
      children: [
        { templateRef: refs.parse },
        { templateRef: refs.aggregate, dependsOn: [0] },
        { templateRef: refs.report, dependsOn: [1] },
      ],
    },
  }
}

/**
 * The mis-ordered v1 coordinating recipe: `[parse, report, aggregate]` with no `dependsOn` at all. The batch runner
 * starts independent children strictly in array order (`task-runtime/src/orchestration/child.ts:553-569`), so the
 * report stage runs before the aggregation stage has produced `out/stats.json` — the "forgotten edge" defect. The
 * criteria are byte-identical to {@link pipelineTemplate}'s; only the recipe changes.
 */
export function misorderedPipelineTemplate(refs: {
  parse: TaskTemplateRef
  aggregate: TaskTemplateRef
  report: TaskTemplateRef
}): TaskTemplate {
  const base = pipelineTemplate(refs)
  return {
    ...base,
    decomposition: {
      reason: 'The three stages produce independently checkable artifacts.',
      children: [{ templateRef: refs.parse }, { templateRef: refs.report }, { templateRef: refs.aggregate }],
    },
  }
}

/** The narrow runtime surface {@link registerLogLibrary} needs. */
export interface TemplateRegistry {
  registerTaskTemplate(template: TaskTemplate): Promise<TaskTemplateRef>
  findTaskTemplates(query?: string): Promise<readonly { readonly templateRef: TaskTemplateRef; readonly template: TaskTemplate }[]>
}

export type AggregateLibrary = 'correct' | 'defective' | 'repaired'

/**
 * Register the standard library. `aggregate` picks the aggregate contract the
 * library holds: the correct v1, the defective v1, or the post-repair library
 * (defective v1 and corrected v2), whose *current* version the pipeline recipe
 * then pins — resolved the way the runtime resolves it, newest version per id.
 */
export async function registerLogLibrary(
  runtime: TemplateRegistry,
  options: { aggregate?: AggregateLibrary; distractors?: number } = {},
): Promise<void> {
  const aggregate = options.aggregate ?? 'correct'
  await runtime.registerTaskTemplate(parseTemplate())
  await runtime.registerTaskTemplate(reportTemplate())
  if (aggregate === 'repaired') {
    await runtime.registerTaskTemplate(aggregateTemplate({ defective: true, version: 1 }))
    await runtime.registerTaskTemplate(aggregateTemplate({ version: 2 }))
  } else {
    await runtime.registerTaskTemplate(aggregateTemplate(aggregate === 'defective' ? { defective: true } : {}))
  }
  for (let index = 0; index < (options.distractors ?? 0); index += 1) {
    await runtime.registerTaskTemplate(unrelatedTemplate(index))
  }
  const current = await runtime.findTaskTemplates()
  const ref = (id: string): TaskTemplateRef => {
    const match = current.find(item => item.templateRef.id === id)
    if (match === undefined) throw new Error(`the library holds no ${id} template`)
    return match.templateRef
  }
  await runtime.registerTaskTemplate(pipelineTemplate({
    parse: ref('parse-log-events'),
    aggregate: ref('aggregate-event-stats'),
    report: ref('render-stats-report'),
  }))
}

/** Device sinks allowed by the advisory path check. */
const HARMLESS_ABSOLUTE = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr'])
/** Known top-level directories: a bare `/tmp` (one slash) still has to be refused, unlike an arithmetic `/1000000`. */
const TOP_LEVEL_DIRS = new Set([
  '/root',
  '/home',
  '/tmp',
  '/etc',
  '/usr',
  '/proc',
  '/var',
  '/opt',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/boot',
  '/srv',
  '/mnt',
  '/media',
  '/dev',
])

/** Drop heredoc bodies (`<<EOF … EOF`) so their text is never scanned as shell syntax. */
function stripHeredocs(command: string): string {
  const lines = command.split('\n')
  const kept: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    kept.push(line)
    const marker = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (marker === null) continue
    const delimiter = marker[2]!
    index += 1
    while (index < lines.length - 1 && lines[index]!.trim() !== delimiter) index += 1
    if (index < lines.length && lines[index]!.trim() === delimiter) kept.push(lines[index]!)
  }
  return kept.join('\n')
}

/** Drop single- and double-quoted spans so quoted prose or arithmetic never looks like a path. */
function stripQuotes(command: string): string {
  return command.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, ' ')
}

/**
 * An advisory path check for normal fixture bash commands, not an OS sandbox: the working directory is pinned to the checkout, but a shell would still
 * follow an absolute path or a `..` traversal anywhere on the machine, and the harness's own sources live outside the
 * checkout. Heredoc bodies and quoted spans are removed first, and a `/` token counts as a path only when it is the root,
 * holds another slash, or names a known top-level directory — so arithmetic like `$((a/1000000))` stays legal. Bare tool
 * names (`node`, `python3`, `make`, `bash checks/verify.sh`) and every relative path stay available.
 */
export function escapingPathIn(command: string, checkout: string): string | undefined {
  const scanned = stripQuotes(stripHeredocs(command))
  const looksLikePath = (token: string): boolean => {
    if (HARMLESS_ABSOLUTE.has(token)) return false
    if (token === '/') return true
    if (!token.startsWith('/')) return false
    if (token.indexOf('/', 1) !== -1) return true
    return TOP_LEVEL_DIRS.has(token)
  }
  for (const token of scanned.split(/[\s;|&()<>]+/)) {
    if (token === '') continue
    if (/(^|\/)\.\.(\/|$)/.test(token)) return `a parent-directory traversal (${token})`
    if (token.startsWith('~')) return `a home path (${token})`
    if (/\$\{?HOME\}?/.test(token)) return '$HOME'
    if (token.startsWith('$') || token.startsWith('`')) continue
    if (!looksLikePath(token)) continue
    const target = resolve(token)
    if (target !== checkout && !target.startsWith(checkout + '/')) {
      return `an absolute path outside the checkout (${token})`
    }
  }
  return undefined
}

/** How a `checkoutTools` bash body is bounded: the wall-clock deadline before its process group is killed. */
export interface CheckoutToolOptions {
  /** The `bash` body's wall-clock deadline in milliseconds. Defaults to 60 seconds, the round-4 bound. */
  readonly bashTimeoutMs?: number
}

/**
 * The real file/shell tools this deployment exposes: `read`, `write` and
 * `bash`. A cross-module engineering task has to *run* the scripts it authors
 * (the checker's `cli` stage executes them end to end), so `bash` gets a real
 * cwd pinned to the checkout, a deadline and an advisory path check.
 */
export function checkoutTools(options: CheckoutToolOptions = {}) {
  const bashTimeoutMs = options.bashTimeoutMs ?? 60_000
  const bashTimeoutSeconds = Math.round(bashTimeoutMs / 1000)
  return ['read', 'write', 'bash'].map(name => defineTool({
    name,
    description: name === 'read'
      ? 'Read a UTF-8 file in this checkout.'
      : name === 'write'
        ? 'Write a UTF-8 file in this checkout.'
        : `Run a bash command with the working directory fixed to this checkout. Commands must terminate: one that runs longer than ${bashTimeoutSeconds} seconds is killed.`,
    parameters: name === 'bash'
      ? { command: { type: 'string', required: true } }
      : { path: { type: 'string', required: true }, ...(name === 'write' ? { content: { type: 'string', required: true } } : {}) },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (args, exec) => {
      const checkout = exec.agent!.session.header.cwd!
      if (name === 'bash') {
        const escaped = escapingPathIn(String(args.command), checkout)
        if (escaped !== undefined) throw new Error(`bash refused: the command names ${escaped}. Use checkout-relative paths.`)
        return await new Promise<string>((settle, fail) => {
          // `detached` puts the command in its own process group so a timeout
          // kills anything it spawned, not just the shell: a backgrounded child
          // holding the stdout pipe is what would otherwise hang the tool body.
          const child = spawn('bash', ['-c', String(args.command)], {
            cwd: checkout, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
          })
          let out = ''
          let err = ''
          let done = false
          const finish = (error: Error | undefined, text: string): void => {
            if (done) return
            done = true
            clearTimeout(timer)
            if (error === undefined) settle(text || '(no output)')
            else fail(error)
          }
          const timer = setTimeout(() => {
            try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
            finish(new Error(`bash timed out after ${bashTimeoutSeconds} seconds and was killed`), '')
          }, bashTimeoutMs)
          child.stdout.on('data', chunk => { out += String(chunk) })
          child.stderr.on('data', chunk => { err += String(chunk) })
          child.on('error', error => finish(error, ''))
          child.on('close', code => {
            if (code === 0) finish(undefined, out)
            else finish(new Error(`bash exited ${code}: ${err || out || 'no output'}`), '')
          })
        })
      }
      const target = resolve(checkout, args.path)
      if (!target.startsWith(checkout + '/')) throw new Error('live validation files must stay inside the checkout')
      if (name === 'read') return await readFile(target, 'utf8')
      await writeFile(target, String(args.content))
      return `wrote ${args.path}`
    },
  }))
}
