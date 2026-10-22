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

export function setupPrompt(request, workspace, checkout = CHECKOUT) {
  return `Prepare a reviewable Singularity RSI environment in ${workspace}.

You are an ordinary top-level DSH session doing environment setup once. Your work ends after presenting the completed package for one final operator review. Do not start RSI, create a Singularity Task or control graph, invoke Singularity tools or bubbles, deploy a host, or change the Singularity checkout. Use ordinary file, shell and web tools. Read ENV_SETUP_CONTEXT.md for current source contracts; inspect the cited source before inventing configuration fields.

Explore the domain, available tools, source references and existing material specified below. Write the requested domain configuration, Task contracts, frozen suite, baseline workflow guidance, Skills/Tools and a domain-owned score calculator. Use the existing file formats and configuration helpers: loadDomain, contractFor and parseSuite; do not reconstruct template or contract digests by hand. Before importing checkout TypeScript in a Node script, await import of scripts/dsh-control-runtime.mjs to resolve private DSH packages. These helpers validate configuration without starting a Task. Keep all generated configuration and evaluator code inside this staging directory. External tool/source references may be absolute paths; record their versions and source revisions. Never copy credentials into the package.

The scoring formula belongs to this environment, not the Singularity kernel. Explain each metric, unit, direction, normalization, coefficient, failure rule and missing-measurement rule. Separate correctness guards from graded quality. Label tool-derived proxies honestly; never present a synthesis proxy as routed silicon PPA. Show raw measurements, every weighted contribution and the resulting score for a baseline and meaningfully different valid candidates. Include an invalid candidate. Check that rounding, clipping, thresholds and normalization do not collapse distinct valid designs to one score. Record actual calculator self-check results. Keep expensive or prohibited evaluation outside scope.

Preserve the distinction between Task nodes, Runs and methods. Give nodes enough global objective and interface context to work within narrow local responsibilities. Prefer a small useful baseline to a prescribed large task tree. Keep evaluation splits and hidden oracle data away from worker references. Freeze evaluator code and formula before search. Report unavailable tools, unverified claims and unresolved assumptions directly.

Required final files:
- SETUP_REVIEW.md: task scope, inputs/provenance, available tool checks, workflow baseline, score derivation and worked examples, validation commands/results, limitations, the exact launch command and the one final review decision needed. Do not approve your own package.
- setup-manifest.json: {"version":1,"domain":"relative/domain-directory","task":"relative/task-contract.json","review":"SETUP_REVIEW.md","files":["relative/path", ...]}. Include the review, all generated configuration, evaluator/oracle sources, score policy and examples, suite, baseline assets and frozen inputs in files. Exclude .env-setup logs, caches and generated build products. All listed entries must be regular files within staging; no symlinks. Include setup-manifest.json itself. All paths are relative; do not list external references as package files.

Once the required real checks and format validations pass, write the review and manifest and finish. Repeat a check only after a relevant change or failure; reuse evidence instead of adding overlapping validation scripts. Finish with a short review request identifying SETUP_REVIEW.md. The CLI will exit after this turn. The operator may make minimal corrections and run singularity env approve to freeze file digests; preparation alone grants no approval and starts no experiment.

User request:
${request.trim()}\n`
}

async function writeContext(workspace, checkout) {
  const files = [
    ['Architecture and responsibility boundaries', 'docs/assembly-blueprint.md'],
    ['Current architecture decisions and implementation limits', 'docs/task-first-domain-rsi-plan.md'],
    ['Task contract schema', 'src/task/contract.ts'],
    ['Node decomposition and dependency invariants', 'src/task/decomposition.ts'],
    ['Domain loader; task.json fields and path visibility', 'assembly/src/domain.ts'],
    ['Canonical Task contract construction; contractFor binds input/template digests', 'assembly/src/inputs.ts'],
    ['Local Task template and method assets', 'assembly/src/template.ts'],
    ['Method loading and baseline construction', 'assembly/src/method.ts'],
    ['Domain-owned measurement interface', 'assembly/src/domain-measurement.ts'],
    ['Frozen multi-case suite and split rules', 'src/measure/suite.ts'],
    ['Host configuration and RSI controls', 'assembly/src/index.ts'],
    ['Portable native DSH installation', 'docs/standalone-dsh.md'],
    ['Setup lifecycle and manifest contract', 'docs/env-setup.md'],
    ['Small working domain example', 'deployment/domain/letters/task.json'],
    ['Native Task / experiment launch commands', 'scripts/singularity.mjs'],
  ]
  const rows = []
  for (const [purpose, file] of files) {
    const path = join(checkout, file), bytes = await readFile(path)
    rows.push(`| ${purpose} | ${path} | ${sha256(bytes)} |`)
  }
  const text = `# Environment setup: source/configuration map\n\nCheckout: ${checkout}\nStaging: ${workspace}\n\nThis is a native headless DSH session. Singularity's assembly, Task scheduler, bubbles, reviewer and RSI are absent. The ordinary DSH session log is the execution record. Source is authoritative; the long-term plan contains pending work and is not a schema.\n\n| Read for | Source file | SHA256 at launch |\n|---|---|---|\n${rows.join('\n')}\n\nRead the domain loader and measurement interface before writing task.json or score code. A domain declares protected inputs, optional local templates, references, verifier implementations, a measurement module and an optional suite. A Task contract declares a goal, artifact, frozen inputs and acceptance criteria. A suite supplies distinct cases and separate evolve/validation/heldout families. Method assets govern how business nodes approach and organize work; they do not grant access to private evaluator data.\n\nThe score calculator is environment-owned executable code, not a kernel formula. Record formula coefficients and raw metric contributions in the review package. A valid package is approved separately with singularity env approve; that records exact bytes without creating a Task or starting RSI.\n`
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
    const prompt = setupPrompt(request, staging, root)
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
    ['domain', 'task', 'review'].some(key => typeof manifest[key] !== 'string' || !manifest[key]))
    throw new Error('setup-manifest.json requires version 1, domain, task, review and files')
  if (new Set(manifest.files).size !== manifest.files.length || !manifest.files.includes(MANIFEST) ||
    !manifest.files.includes(manifest.task) || !manifest.files.includes(manifest.review))
    throw new Error('Manifest files must be unique and include the manifest, task and review')
  if (manifest.files.some(file => typeof file !== 'string' || file === APPROVAL || file.startsWith('.env-setup/')))
    throw new Error('Approval and native run logs are not environment package inputs')
  const files = []
  for (const file of [...manifest.files].sort()) files.push(await packageFile(root, file))
  // Domain path has to be inside staging and point to a manifest-listed declaration.
  if (!manifest.files.includes(`${manifest.domain}/task.json`)) throw new Error('Manifest files must include domain/task.json')
  await packageFile(root, `${manifest.domain}/task.json`)
  const approval = { version: 1, reviewedBy: reviewer, approvedAt: new Date().toISOString(),
    manifestDigest: sha256(manifestBytes), domain: manifest.domain, task: manifest.task, files }
  await writeFile(join(root, APPROVAL), JSON.stringify(approval, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return { ...approval, approvalFile: join(root, APPROVAL) }
}
