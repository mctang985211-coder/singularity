/** One ordinary native DSH session prepares a reviewable environment before RSI. */
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify, stripVTControlCharacters } from 'node:util'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECKOUT, hostFindings, hostInstall } from './host-config.mjs'

const execute = promisify(execFile)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const MANIFEST = 'setup-manifest.json'
const APPROVAL = 'environment-approval.json'
const interactivePatch = fileURLToPath(new URL('../deployment/env-setup.patch.yml', import.meta.url))
const shellWord = value => "'" + value.replaceAll("'", "'\\''") + "'"

// The table, persisted answers and native todo list use the same six row identities.
export const SETUP_FIELDS = [
  [
    'tasks',
    'Tasks and transfer',
    'User-supplied tasks/source revisions, finite artifacts, family/source/split, weights and trials; full transfer or smoke scope. Never invent replacement tasks or independence.',
  ],
  [
    'runtime',
    'Runtime and resources',
    'Executable paths/versions actually usable inside Bubble, CPU/GPU, threads, timeouts and budgets; evaluation parallelism=1. Probe existing dependencies before writing adapters.',
  ],
  [
    'acceptance',
    'Correctness before calibration',
    'Inspect actual returns, declared outputs and permitted mutations against code and metadata. Check each retained baseline on required sizes/seeds before timing it. Exclusion, replacement, output/tolerance changes require a user decision. A valid baseline near 1 need not meet an improvement target.',
  ],
  [
    'scoring',
    'Frozen scoring',
    'Units, direction, baseline, target, formula, hard guards, failure/missing-data policy, quality/cost weights and noiseFloor. Calibrate with the same timing/reset/process policy as candidates. Incorrect candidates are business-failure; apparatus failures throw.',
  ],
  [
    'visibility',
    'Inputs and references',
    'Per-case protected inputs, shared public docs/scorer and private suite/checks. Select relevant user reference docs without activating embedded roles/policies/workflows. No private case catalogue in describe() or inherited host filesystem. Use assembly/src/process.ts spawnProcess with an explicit BubbleWorld for host scoring.',
  ],
  [
    'verification',
    'Package and end-to-end evidence',
    'Minimal manifest; actual Bubble executable/CLI and host measurement probes, known-valid and wrong/malformed/missing candidates, denied private reads, loaded tool-name uniqueness including core node. No unresolved failures; record commands and raw evidence outside the manifest.',
  ],
]

export function assertOrdinarySetupConfig(config, interactive = false) {
  if (
    /\bsingularity-assembly\b|@dangosys\/dsh-singularity-next|\bsingularity-(?:root|task|review|improve)\b/.test(config)
  )
    throw new Error(
      'Environment setup must use an ordinary DSH profile without Singularity plugins or presets; pass only a model-route patch',
    )
  if (!interactive && !/\bid: headless-runner\b/.test(config)) throw new Error('The native headless runner is missing')
  if (interactive && (!/\bid: preset-env-setup\b/.test(config) || !/\bid: ui-user-questions\b/.test(config)))
    throw new Error('Interactive setup requires the native env-setup preset and user-question UI')
}

export function setupPrompt(request, workspace, interactive = false) {
  const checkCommand = `node ${shellWord(join(CHECKOUT, 'scripts/singularity.mjs'))} env check ${shellWord(workspace)}`
  return `Prepare the requested RSI environment in ${workspace}. This is ordinary DSH; do not approve, deploy, start Tasks/RSI or change the checkout. Read ENV_SETUP_CONTEXT.md for the ordered configuration table and interfaces.

First call todo_write with one todo per table row, followed by user review. Work in that order, one item in_progress. Fill .env-setup/config.json with each row's concrete value and evidence (commands/results or log paths); mark a todo completed only after its checks pass. Inspect discoverable facts yourself. Reuse supplied choices; ask only about missing user-owned decisions or conflicts. ${interactive ? 'Use the native ask_user_question window: batch related questions, offer concrete options with a recommended first choice and a custom-answer path. Do not proceed past a required decision until answered; skipped/pending/cancelled is not approval. A pending question can be answered later in this same session; keep its row blocked. Apply feedback here.' : 'This headless session has no answer UI. If a material decision is missing, report the blocked rows and finish without claiming readiness; recommend --interactive. Do not assume an answer.'}

Package only the user-supplied task suite, acceptance, frozen scoring and necessary agent score tools. Keep scorer rules and invocation help with the scorer; tasks cite its command. Method/Skill/TaskTemplate assets, decomposition, workflow guidance, standalone Task files, solvers, extra documents and launch/verification scaffolding require an explicit user request. Singularity supplies the empty method and explores RSI itself. Verify with small fixtures without searching for solutions. Never record credentials.

Write setup-manifest.json: {"version":1,"domain":"relative/domain-directory","files":["relative/path", ...]}. List itself and all environment inputs/code/config. Use regular staging files, no symlinks; exclude ENV_SETUP_CONTEXT.md, .env-setup/, logs, caches and temporary fixtures. Run ${checkCommand}; resolve failures in this session and repeat only affected checks. Once it passes, stop extending the package. ${interactive ? 'Use ask_user_question for final review: show the filled table, exact files, scope changes, evidence and limitations; offer reviewed / requested changes / defer. Apply requested edits and recheck changed parts before requesting review again. Defer or skipped answers leave review pending. User review is not a self-issued environment-approval.json.' : 'Leave user review pending.'} Report readiness/review status, limitations and dependency versions briefly, then finish. Signing remains the separate env approve operation.

User request:
${request.trim()}\n`
}

async function writeContext(workspace, checkout) {
  const files = [
    ['Task contract schema', 'src/task/contract.ts'],
    ['Domain loader; task.json fields and path visibility', 'assembly/src/domain.ts'],
    ['Frozen multi-case suite and split rules', 'src/measure/suite.ts'],
    ['Optional numeric measurement adapter', 'assembly/src/domain-measurement.ts'],
  ]
  const rows = []
  for (const [purpose, file] of files) {
    const path = join(checkout, file),
      bytes = await readFile(path)
    rows.push(`| ${purpose} | ${path} | ${sha256(bytes)} |`)
  }
  const table = SETUP_FIELDS.map(([id, label, checks], index) => `| ${index + 1}. ${id}: ${label} | ${checks} |`).join(
    '\n',
  )
  const text = `# Minimal environment interface\n\nCheckout: ${checkout}\nStaging: ${workspace}\n\n## Ordered configuration TODO\n\nFill .env-setup/config.json: {version:1, items:[{id,value,evidence:["command/result or log path"]}, ...]}. Values are concrete configuration, not "done". Use these row ids in order; evidence must cover the checks. Native todo_write shows progress; this file retains the answers. After these six rows, request user review. These are builder records, not RSI assets.\n\n| TODO / configuration | Verify before completing |\n|---|---|\n${table}\n\n## Domain interfaces\n\nPaths below are relative to the domain directory. Omit unused templates/verifiers/inputs.\n\nDomain task.json: {"inputs":[{"ref":"data","from":"input.json"}],"suite":"suite.json","references":["public"]}\nSuite: {"version":1,"suiteId":"DOMAIN","failureQuality":0,"cases":[CASE, ...]}\nCASE: {"caseId":"CASE","familyId":"FAMILY","sourceId":"SOURCE","split":"evolve","weight":1,"trials":2,"contract":{"goal":"finite task content; score command","artifact":"result.json","inputs":[{"name":"input.json","source":{"kind":"protected","ref":"data","digest":"SHA256 of input bytes"}}],"criteria":[{"criterionId":"correct","statement":"acceptance standard"}]},"hardGuards":["correct"]}\n\nUse distinct evolve/validation/heldout families and sources. Publication comparisons require at least three independent families and two trials per case in each compared split; smaller suites are smoke tests.\n\nTask acceptance uses independent reviewers. Default suite quality is 1 for acceptance, otherwise failureQuality. Optional scoring: "criteria" counts passed non-guard criteria; numeric objectives can use a measurement adapter instead. Public score CLI code/help goes in references and runs via the agent shell at its absolute staging path; no Method Tool/Skill is needed. The suite and hidden evaluator data stay outside references.\n\nHost measurement must use the confined spawnProcess interface with only current inputs/candidate and public references. Core already records tool "node"; do not declare that name again. describe() is worker-visible: use aggregate hashes for private case metadata.\n\nSource details only when needed (not a reading checklist). Before importing checkout TypeScript, import ${join(checkout, 'scripts/dsh-control-runtime.mjs')}.\n\n| Interface | Source | SHA256 at launch |\n|---|---|---|\n${rows.join('\n')}\n`
  await writeFile(join(workspace, 'ENV_SETUP_CONTEXT.md'), text, { mode: 0o600 })
  await writeFile(
    join(workspace, '.env-setup/config.json'),
    JSON.stringify({ version: 1, items: SETUP_FIELDS.map(([id]) => ({ id, value: null, evidence: [] })) }, null, 2) +
      '\n',
    { mode: 0o600 },
  )
}

/** Uses shipped native bundles directly; never connects to a Singularity host. */
export async function runEnvironmentSetup({
  request,
  workspace,
  patch,
  checkout = CHECKOUT,
  binary,
  env = process.env,
  interactive = false,
  output = process.stdout,
} = {}) {
  if (typeof request !== 'string' || !request.trim()) throw new Error('Environment setup request must be nonempty')
  if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('env setup requires --workspace DIR')
  const staging = resolve(workspace)
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const root = await realpath(checkout),
    actualStaging = await realpath(staging)
  const fromCheckout = relative(root, actualStaging)
  if (!fromCheckout || (fromCheckout !== '..' && !fromCheckout.startsWith(`..${sep}`) && !isAbsolute(fromCheckout)))
    throw new Error('Setup staging must be outside the Singularity checkout')
  if (!env.DSH_HOME)
    throw new Error('env setup requires an explicit private DSH_HOME with the intended credentials and model route')
  if (!binary) {
    const installed = hostInstall(),
      findings = hostFindings(installed)
    if (findings.length) throw new Error(findings.join('; '))
    binary = env.DSH_BIN || join(dirname(installed), '.bin', 'dsh')
  }
  const args = [
    '--profile',
    interactive ? 'web' : 'headless',
    ...(patch ? ['--patch', resolve(patch)] : []),
    ...(interactive ? ['--patch', interactivePatch] : []),
  ]
  const nativeEnv = { ...env }
  delete nativeEnv.SINGULARITY_TOKEN
  delete nativeEnv.SINGULARITY_COOKIE
  const record = join(staging, '.env-setup')
  // One invocation, one native Session. An existing record needs a new staging directory.
  await mkdir(record, { mode: 0o700 })
  const temporary = await mkdtemp(join(actualStaging, '.env-setup', 'tmp-'))
  // Ordinary native tools must not discover a parent repository or inherit another
  // checkout's index/object database. Direct git -C /actual/checkout still works.
  for (const key of Object.keys(nativeEnv))
    if (
      [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_COMMON_DIR',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_INDEX_FILE',
        'GIT_GRAFT_FILE',
        'GIT_SHALLOW_FILE',
        'GIT_PREFIX',
        'GIT_INTERNAL_SUPER_PREFIX',
        'GIT_IMPLICIT_WORK_TREE',
        'GIT_NO_REPLACE_OBJECTS',
        'GIT_REPLACE_REF_BASE',
        'GIT_CONFIG',
        'GIT_CONFIG_PARAMETERS',
        'GIT_CONFIG_COUNT',
        'GIT_DISCOVERY_ACROSS_FILESYSTEM',
      ].includes(key) ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
    )
      delete nativeEnv[key]
  // Git ignores a ceiling equal to its initial cwd, so include the parent too.
  Object.assign(nativeEnv, {
    GIT_CEILING_DIRECTORIES: [actualStaging, dirname(actualStaging)].join(delimiter),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
  })
  try {
    const { stdout: config } = await execute(binary, [...args, '--dump-config'], {
      cwd: staging,
      env: nativeEnv,
      maxBuffer: 4 * 1024 * 1024,
    })
    assertOrdinarySetupConfig(config, interactive)
    await writeContext(staging, root)
    const prompt = setupPrompt(request, staging, interactive)
    await writeFile(join(record, 'prompt.md'), prompt, { mode: 0o600 })
    await writeFile(join(record, 'effective-config.yml'), config, { mode: 0o600 })
    if (interactive) return await runInteractiveSetup({ binary, args, staging, nativeEnv, record, prompt, output })
    const events = await open(join(record, 'events.jsonl'), 'wx', 0o600)
    const diagnostics = await open(join(record, 'diagnostics.log'), 'wx', 0o600)
    let code
    try {
      code = await new Promise((done, reject) => {
        const child = spawn(binary, [...args, '--json', '-'], {
          cwd: staging,
          env: nativeEnv,
          stdio: ['pipe', events.fd, diagnostics.fd],
        })
        child.once('error', reject)
        child.once('exit', (status, signal) =>
          signal ? reject(new Error(`Native setup session stopped by ${signal}; inspect ${record}`)) : done(status),
        )
        child.stdin.on('error', error => {
          if (error.code !== 'EPIPE') reject(error)
        })
        child.stdin.end(prompt)
      })
    } finally {
      await events.close()
      await diagnostics.close()
    }
    const stream = (await readFile(join(record, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
    const session = stream.find(event => event.type === 'session')
    const final = stream.findLast(event => event.type === 'final')
    const result = {
      version: 1,
      sessionId: session?.sessionId ?? null,
      exitCode: code,
      workspace: staging,
      approval: 'pending',
      manifest: join(staging, MANIFEST),
      final: final?.text ?? null,
    }
    await writeFile(join(record, 'run.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
    if (code !== 0 || !session || !final)
      throw new Error(`Native environment setup did not complete (exit ${code}); inspect ${record}`)
    return result
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

/** Web owns questions, answers and resumed turns; this entry only seeds one ordinary session. */
async function runInteractiveSetup({ binary, args, staging, nativeEnv, record, prompt, output }) {
  const { connectHost, cleanError } = await import('./singularity.mjs')
  const diagnostics = await open(join(record, 'diagnostics.log'), 'wx', 0o600)
  const result = {
    version: 1,
    mode: 'interactive',
    workspace: staging,
    sessionId: null,
    approval: 'pending',
    manifest: join(staging, MANIFEST),
    state: 'starting',
  }
  let child,
    bootstrap,
    failure,
    logged = Promise.resolve()
  try {
    const exit = new Promise((done, reject) => {
      child = spawn(binary, [...args, '--host', '127.0.0.1', '--port', '0'], {
        cwd: staging,
        env: nativeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.once('error', reject)
      child.once('close', (exitCode, signal) => done({ exitCode, signal }))
    })
    const start = async url => {
      const address = new URL(url)
      const host = await connectHost({ url, token: address.searchParams.get('token'), cookie: '' })
      const sessionId = `env-setup-${sha256(staging).slice(0, 24)}`
      const { workspace } = await host.rpc('workspace/create', { path: staging })
      if (typeof workspace?.workspaceId !== 'string')
        throw new Error('Native host did not register the setup workspace')
      const created = await host.rpc('session/create', {
        sessionId,
        agentPreset: 'env-setup',
        workspaceId: workspace.workspaceId,
      })
      if (created.sessionId !== sessionId) throw new Error('Native host changed setup session identity')
      await host.rpc('session/prompt', {
        sessionId,
        requestId: `${sessionId}-request`,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      address.search = ''
      address.hash = ''
      Object.assign(result, { sessionId, workspaceId: workspace.workspaceId, url: address.href, state: 'interactive' })
      await writeFile(join(record, 'run.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
      output.write(
        `Environment builder session: ${sessionId}. Review TODOs and questions in the native Web UI; Ctrl+C stops this setup host.\n`,
      )
    }
    const stop = () => child.kill('SIGTERM')
    const startupDeadline = setTimeout(() => {
      if (!result.sessionId) {
        failure = new Error('Native setup Web session did not start within 30s')
        stop()
      }
    }, 30_000)
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8')
      let pending = ''
      const line = text => {
        output.write(text + '\n')
        logged = logged.then(() => diagnostics.write(cleanError(stripVTControlCharacters(text)) + '\n'))
        const url = stripVTControlCharacters(text).match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1]
        if (url && !bootstrap)
          bootstrap = start(url).catch(error => {
            failure = error
            stop()
          })
      }
      stream.on('data', chunk => {
        pending += chunk
        for (;;) {
          const at = pending.indexOf('\n')
          if (at < 0) break
          line(pending.slice(0, at))
          pending = pending.slice(at + 1)
        }
      })
      stream.on('end', () => {
        if (pending) line(pending)
      })
    }
    let ended
    try {
      ended = await exit
      await bootstrap
      await logged
    } finally {
      clearTimeout(startupDeadline)
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    }
    Object.assign(result, ended, {
      state: failure ? 'failed' : 'host-stopped',
      ...(failure ? { failure: cleanError(failure) } : {}),
    })
    await writeFile(join(record, 'run.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
    if (failure) throw failure
    if (!result.sessionId) throw new Error(`Native setup Web host did not create a session; inspect ${record}`)
    if (ended.exitCode !== 0 && !ended.signal)
      throw new Error(`Native setup Web host exited ${ended.exitCode}; inspect ${record}`)
    return result
  } finally {
    await diagnostics.close()
  }
}

async function packageFile(root, file) {
  if (
    typeof file !== 'string' ||
    !file ||
    isAbsolute(file) ||
    file.includes('\\') ||
    file.split('/').some(part => !part || part === '.' || part === '..')
  )
    throw new Error(`Package path must be a normalized relative file: ${String(file)}`)
  const parts = file.split('/')
  for (let i = 1; i <= parts.length; i++) {
    const path = join(root, ...parts.slice(0, i)),
      entry = await lstat(path)
    if (entry.isSymbolicLink()) throw new Error(`Package must not contain symlinks: ${file}`)
    if (i === parts.length && !entry.isFile()) throw new Error(`Package entry is not a regular file: ${file}`)
  }
  return { path: file, sha256: sha256(await readFile(join(root, file))) }
}

/** Readiness is checked without creating a Task or calling a model; score evidence remains reviewable. */
export async function checkEnvironmentSetup(workspace) {
  const root = await realpath(resolve(workspace)),
    checks = []
  const check = async (name, work) => {
    try {
      checks.push({ name, ok: true, detail: await work() })
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error) })
    }
  }
  await check('configuration table', async () => {
    const table = JSON.parse(await readFile(join(root, '.env-setup/config.json'), 'utf8'))
    if (table.version !== 1 || !Array.isArray(table.items) || table.items.length !== SETUP_FIELDS.length)
      throw new Error('Complete the six configuration rows in .env-setup/config.json')
    for (const [index, [id]] of SETUP_FIELDS.entries()) {
      const row = table.items[index]
      if (
        row?.id !== id ||
        row.value === null ||
        row.value === undefined ||
        (typeof row.value === 'string' && !row.value.trim()) ||
        !Array.isArray(row.evidence) ||
        !row.evidence.length ||
        row.evidence.some(item => typeof item !== 'string' || !item.trim())
      )
        throw new Error(`Configuration row ${id} needs a concrete value and verification evidence`)
    }
    return 'all six rows filled; evidence must also be assessed in user review'
  })
  await check('manifest and domain', async () => {
    const manifest = JSON.parse(await readFile(join(root, MANIFEST), 'utf8'))
    if (
      manifest.version !== 1 ||
      !Array.isArray(manifest.files) ||
      !manifest.files.includes(MANIFEST) ||
      new Set(manifest.files).size !== manifest.files.length ||
      !manifest.files.includes(`${manifest.domain}/task.json`)
    )
      throw new Error('Manifest requires version 1, a domain/task.json and unique files including itself')
    for (const file of manifest.files) {
      if (file === APPROVAL || file.startsWith('.env-setup/'))
        throw new Error('Builder logs/approval are not package inputs')
      await packageFile(root, file)
    }
    await import('./dsh-control-runtime.mjs')
    const [{ loadDomain }, { spawnProcess }] = await Promise.all([
      import('../assembly/src/domain.ts'),
      import('../assembly/src/process.ts'),
    ])
    const domain = await loadDomain(join(root, manifest.domain), spawnProcess)
    if (!domain.suite) throw new Error('Environment requires the user-supplied task suite')
    const listed = new Set(manifest.files)
    const visit = async path => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name)
        if (entry.isSymbolicLink()) throw new Error(`Package must not contain symlinks: ${child}`)
        if (entry.isDirectory()) await visit(child)
        else if (!listed.has(relative(root, child))) throw new Error(`Unlisted domain file: ${relative(root, child)}`)
      }
    }
    await visit(domain.dir)
    const names = ['node', ...(domain.measurement?.tools ?? []).map(tool => tool.name)]
    if (new Set(names).size !== names.length)
      throw new Error('Measurement tools repeat a name or redeclare core tool node')
    for (const input of domain.inputs) {
      if (!manifest.files.includes(`${manifest.domain}/${input.sourcePath}`))
        throw new Error(`Unlisted input: ${input.sourcePath}`)
      const path = await realpath(join(domain.dir, input.sourcePath))
      for (const ref of domain.references) {
        const parent = await realpath(ref)
        if (path === parent || path.startsWith(parent + sep))
          throw new Error(`Protected input exposed in public references: ${input.sourcePath}`)
      }
    }
    const parameters = JSON.stringify(domain.measurement?.parameters ?? {})
    for (const c of domain.suite.cases.filter(c => c.split !== 'evolve'))
      if (parameters.includes(JSON.stringify(c.caseId)))
        throw new Error(`Private case exposed in measurement parameters: ${c.caseId}`)
    const coverage = ['evolve', 'validation', 'heldout'].map(split => {
      const cases = domain.suite.cases.filter(c => c.split === split)
      return {
        split,
        families: new Set(cases.map(c => c.familyId)).size,
        cases: cases.length,
        atLeastTwoTrials: cases.length > 0 && cases.every(c => c.trials >= 2),
      }
    })
    return {
      cases: domain.suite.cases.length,
      coverage,
      scope: coverage.every(c => c.families >= 3 && c.atLeastTwoTrials) ? 'transfer-coverage' : 'smoke-only',
      note: 'Tool names unique; protected inputs remain private. Numerical/Bubble probes and actual family independence require the recorded evidence and user review.',
    }
  })
  const result = { ok: checks.every(check => check.ok), checks }
  await mkdir(join(root, '.env-setup'), { recursive: true, mode: 0o700 })
  await writeFile(join(root, '.env-setup/check.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  return result
}

/** The operator reviews actual files first; freezing does not execute or deploy them. */
export async function approveEnvironmentSetup(workspace, { reviewer = 'operator' } = {}) {
  const root = await realpath(resolve(workspace))
  // Older externally prepared packages lack the builder table and keep their explicit review path.
  let hasTable = false
  try {
    await lstat(join(root, '.env-setup/config.json'))
    hasTable = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (hasTable && !(await checkEnvironmentSetup(root)).ok)
    throw new Error('Environment readiness checks failed; inspect .env-setup/check.json before approval')
  const manifestBytes = await readFile(join(root, MANIFEST))
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    typeof manifest.domain !== 'string' ||
    !manifest.domain
  )
    throw new Error('setup-manifest.json requires version 1, domain and files')
  if (new Set(manifest.files).size !== manifest.files.length || !manifest.files.includes(MANIFEST))
    throw new Error('Manifest files must be unique and include the manifest')
  for (const key of ['task', 'review'])
    if (manifest[key] !== undefined && (typeof manifest[key] !== 'string' || !manifest.files.includes(manifest[key])))
      throw new Error(`Optional ${key} must be a manifest-listed file`)
  if (manifest.files.some(file => typeof file !== 'string' || file === APPROVAL || file.startsWith('.env-setup/')))
    throw new Error('Approval and native run logs are not environment package inputs')
  const files = []
  for (const file of [...manifest.files].sort()) files.push(await packageFile(root, file))
  // Domain path has to be inside staging and point to a manifest-listed declaration.
  if (!manifest.files.includes(`${manifest.domain}/task.json`))
    throw new Error('Manifest files must include domain/task.json')
  await packageFile(root, `${manifest.domain}/task.json`)
  const approval = {
    version: 1,
    reviewedBy: reviewer,
    approvedAt: new Date().toISOString(),
    manifestDigest: sha256(manifestBytes),
    domain: manifest.domain,
    ...(manifest.task === undefined ? {} : { task: manifest.task }),
    files,
  }
  await writeFile(join(root, APPROVAL), JSON.stringify(approval, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return { ...approval, approvalFile: join(root, APPROVAL) }
}
