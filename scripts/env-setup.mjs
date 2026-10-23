/** One ordinary native DSH session prepares a reviewable environment before RSI. */
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CHECKOUT, hostFindings, hostInstall } from './host-config.mjs'

const execute = promisify(execFile)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const MANIFEST = 'setup-manifest.json'
const APPROVAL = 'environment-approval.json'

export function assertOrdinarySetupConfig(config) {
  if (/\bsingularity-assembly\b|@dangosys\/dsh-singularity-next|\bsingularity-(?:root|task|review|improve)\b/.test(config))
    throw new Error('Environment setup must use an ordinary headless DSH profile without Singularity plugins or presets; pass only a model-route patch')
  if (!/\bid: headless-runner\b/.test(config)) throw new Error('The native headless runner is missing')
}

export function setupPrompt(request, workspace) {
  return `Prepare the requested RSI environment in ${workspace}. This is ordinary DSH; do not approve, deploy, start Tasks/RSI or change the checkout. Read ENV_SETUP_CONTEXT.md for interfaces.

Provide same-domain task content as a suite, acceptance criteria, a fixed scoring policy and only the tools needed for agents to test scores. Suite contracts describe finite deliverables, not solving procedures. State scoring trade-offs and hard guards consistently; define units, normalization and failure/missing-data rules. Separate evolve/validation/heldout families and keep private cases/checks outside worker references. Expose scorer usage through public references and task content.

Unless the user explicitly requests them, omit Method files, Skills, TaskTemplates, decomposition, workflow guidance, standalone Task files, solver implementations and launch/verification scaffolding. Singularity starts with an empty method and explores RSI itself. Keep required schema arrays empty when unused.

Check loading and scoring with small known-valid/invalid fixtures; do not search for better solutions. Record observed scores and limitations briefly in SETUP_REVIEW.md, referencing scoring code for details. Evaluation parallelism is 1. Record external dependencies/versions without credentials.

Write setup-manifest.json: {"version":1,"domain":"relative/domain-directory","review":"SETUP_REVIEW.md","files":["relative/path", ...]}. Include itself, the review and all environment inputs/code/config. Use regular files inside staging, no symlinks; exclude logs, caches and temporary checks. Identify the review in your final answer and finish.

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
    const path = join(checkout, file), bytes = await readFile(path)
    rows.push(`| ${purpose} | ${path} | ${sha256(bytes)} |`)
  }
  const text = `# Environment interfaces\n\nCheckout: ${checkout}\nStaging: ${workspace}\n\nRead only relevant schemas. Before importing checkout TypeScript, import ${join(checkout, 'scripts/dsh-control-runtime.mjs')} for native dependency resolution. Historical plans and the template-based reference example are not generation requirements.\n\n| Read for | Source file | SHA256 at launch |\n|---|---|---|\n${rows.join('\n')}\n\nThe domain task.json declares inputs, verifiers and templates arrays, public references and a suite path. Use templates: [] by default; suite cases directly contain task contracts with goal, artifact, protected inputs (exact SHA256) and criteria. No separate root Task or method file is needed. The host supplies the empty method seed.\n\nA public score CLI can live in a read-only references subtree and run via the agent's shell, without a Method Tool or Skill. Keep the suite and hidden evaluator data outside public references. Scoring may use whole-task pass, suite scoring: "criteria", or an optional measurement module; choose the simplest suitable interface. Approval freezes listed bytes separately; this session only prepares the environment.\n`
  await writeFile(join(workspace, 'ENV_SETUP_CONTEXT.md'), text, { mode: 0o600 })
}

/** Uses the shipped headless bundle directly; never connects to a Singularity host. */
export async function runEnvironmentSetup({ request, workspace, patch, checkout = CHECKOUT, binary, env = process.env } = {}) {
  if (typeof request !== 'string' || !request.trim()) throw new Error('Environment setup request must be nonempty')
  if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('env setup requires --workspace DIR')
  const staging = resolve(workspace)
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const root = await realpath(checkout), actualStaging = await realpath(staging)
  const fromCheckout = relative(root, actualStaging)
  if (!fromCheckout || fromCheckout !== '..' && !fromCheckout.startsWith(`..${sep}`) && !isAbsolute(fromCheckout))
    throw new Error('Setup staging must be outside the Singularity checkout')
  if (!env.DSH_HOME) throw new Error('env setup requires an explicit private DSH_HOME with the intended credentials and model route')
  if (!binary) {
    const installed = hostInstall(), findings = hostFindings(installed)
    if (findings.length) throw new Error(findings.join('; '))
    binary = env.DSH_BIN || join(dirname(installed), '.bin', 'dsh')
  }
  const args = ['--profile', 'headless', ...(patch ? ['--patch', resolve(patch)] : [])]
  const nativeEnv = { ...env }
  delete nativeEnv.SINGULARITY_TOKEN
  delete nativeEnv.SINGULARITY_COOKIE
  const record = join(staging, '.env-setup')
  // One invocation, one native Session. An existing record needs a new staging directory.
  await mkdir(record, { mode: 0o700 })
  const temporary = await mkdtemp(join(actualStaging, '.env-setup', 'tmp-'))
  // Ordinary native tools must not discover a parent repository or inherit another
  // checkout's index/object database. Direct git -C /actual/checkout still works.
  for (const key of Object.keys(nativeEnv)) if ([
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_INDEX_FILE', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE', 'GIT_PREFIX', 'GIT_INTERNAL_SUPER_PREFIX',
    'GIT_IMPLICIT_WORK_TREE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE',
    'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  ].includes(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete nativeEnv[key]
  // Git ignores a ceiling equal to its initial cwd, so include the parent too.
  Object.assign(nativeEnv, { GIT_CEILING_DIRECTORIES: [actualStaging, dirname(actualStaging)].join(delimiter),
    TMPDIR: temporary, TMP: temporary, TEMP: temporary })
  try {
    const { stdout: config } = await execute(binary, [...args, '--dump-config'], { cwd: staging, env: nativeEnv, maxBuffer: 4 * 1024 * 1024 })
    assertOrdinarySetupConfig(config)
    await writeContext(staging, root)
    const prompt = setupPrompt(request, staging)
    await writeFile(join(record, 'prompt.md'), prompt, { mode: 0o600 })
    await writeFile(join(record, 'effective-config.yml'), config, { mode: 0o600 })
    const events = await open(join(record, 'events.jsonl'), 'wx', 0o600)
    const diagnostics = await open(join(record, 'diagnostics.log'), 'wx', 0o600)
    let code
    try {
      code = await new Promise((done, reject) => {
        const child = spawn(binary, [...args, '--json', '-'], { cwd: staging, env: nativeEnv, stdio: ['pipe', events.fd, diagnostics.fd] })
        child.once('error', reject)
        child.once('exit', (status, signal) => signal ? reject(new Error(`Native setup session stopped by ${signal}; inspect ${record}`)) : done(status))
        child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error) })
        child.stdin.end(prompt)
      })
    } finally { await events.close(); await diagnostics.close() }
    const stream = (await readFile(join(record, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const session = stream.find(event => event.type === 'session')
    const final = stream.findLast(event => event.type === 'final')
    const result = { version: 1, sessionId: session?.sessionId ?? null, exitCode: code, workspace: staging,
      approval: 'pending', review: join(staging, 'SETUP_REVIEW.md'), final: final?.text ?? null }
    await writeFile(join(record, 'run.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
    if (code !== 0 || !session || !final) throw new Error(`Native environment setup did not complete (exit ${code}); inspect ${record}`)
    return result
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

async function packageFile(root, file) {
  if (typeof file !== 'string' || !file || isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error(`Package path must be a normalized relative file: ${String(file)}`)
  const parts = file.split('/')
  for (let i = 1; i <= parts.length; i++) {
    const path = join(root, ...parts.slice(0, i)), entry = await lstat(path)
    if (entry.isSymbolicLink()) throw new Error(`Package must not contain symlinks: ${file}`)
    if (i === parts.length && !entry.isFile()) throw new Error(`Package entry is not a regular file: ${file}`)
  }
  return { path: file, sha256: sha256(await readFile(join(root, file))) }
}

/** The operator reviews actual files first; freezing does not execute or deploy them. */
export async function approveEnvironmentSetup(workspace, { reviewer = 'operator' } = {}) {
  const root = await realpath(resolve(workspace))
  const manifestBytes = await readFile(join(root, MANIFEST))
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length ||
    ['domain', 'review'].some(key => typeof manifest[key] !== 'string' || !manifest[key]))
    throw new Error('setup-manifest.json requires version 1, domain, review and files')
  if (new Set(manifest.files).size !== manifest.files.length || !manifest.files.includes(MANIFEST) ||
    !manifest.files.includes(manifest.review))
    throw new Error('Manifest files must be unique and include the manifest and review')
  if (manifest.task !== undefined && (typeof manifest.task !== 'string' || !manifest.files.includes(manifest.task)))
    throw new Error('An optional standalone task must be a manifest-listed file')
  if (manifest.files.some(file => typeof file !== 'string' || file === APPROVAL || file.startsWith('.env-setup/')))
    throw new Error('Approval and native run logs are not environment package inputs')
  const files = []
  for (const file of [...manifest.files].sort()) files.push(await packageFile(root, file))
  // Domain path has to be inside staging and point to a manifest-listed declaration.
  if (!manifest.files.includes(`${manifest.domain}/task.json`)) throw new Error('Manifest files must include domain/task.json')
  await packageFile(root, `${manifest.domain}/task.json`)
  const approval = { version: 1, reviewedBy: reviewer, approvedAt: new Date().toISOString(),
    manifestDigest: sha256(manifestBytes), domain: manifest.domain, ...(manifest.task === undefined ? {} : { task: manifest.task }), files }
  await writeFile(join(root, APPROVAL), JSON.stringify(approval, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return { ...approval, approvalFile: join(root, APPROVAL) }
}
