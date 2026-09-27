/**
 * A6 EVO-4: the **joint commit's durable windows**, crossed by a process that is
 * really killed (plan §F.4: 联合提交的每个持久边界…分别注入死亡并重开; 不得以同进程
 * 异常模拟冒充跨进程重开).
 *
 * The commit this crosses is A6's own: **one capability row plus the new
 * execution skill it grants**, written as one commit — the run's intent, the
 * object's two files, the registry's row, the deployment's `config.yml` text and
 * the completion line. Five windows sit between those writes, and each is a
 * different durable state:
 *
 * | boundary | what has landed | what a restart loads |
 * |---|---|---|
 * | `intent-recorded` | the ledger's intent only | no row, no file: the baseline |
 * | `files-written` | both files renamed into production | no row: the object is on disk and nothing grants it |
 * | `registry-row` | the row in the *process* registry, the files on disk | no row: the half-product the config file is the last step against |
 * | `table-text` | the row written into `config.yml` | the row and the object, with the completion line still missing |
 * | `completion-pending` | everything durable, nothing recorded | the applied state, its completion owed |
 *
 * How the death is real, and why a throw is not it. The child case boots its own
 * deployment over the shared directory, walks the proposal to `decided` and calls
 * `apply`; the armed window answers with `process.kill(process.pid, 'SIGKILL')`
 * (see `tests/support/process-death.ts`). No `catch`, no `finally`, no staging
 * file removed, no descriptor closed by a handler, no memory left — the state the
 * parent reads is what the kernel and the filesystem kept. `capability-candidate
 * .spec.ts` keeps the *throw* variants of these same seams as the cheap in-process
 * statements of the stage order; they are not this evidence and are labeled so,
 * and where they claimed a restart they were replaced by these cases.
 *
 * The reopen is the parent's own boot: a second deployment over the same
 * directory — its own service instance, its own in-memory registry, reading the
 * ledger, the files and `config.yml` off disk — which refuses nothing the open
 * intent names, settles it through the reconciliation a restart runs, and ends
 * with exactly one completion. Every assertion is read from a durable surface: the
 * ledger's own lines (re-read from the file), the bytes under the production skill
 * root, the row's text inside `config.yml` (the table a restart loads), and the
 * service's own open-intent view.
 *
 * The recovery windows of the same ticket — a new Run created, an admitted batch
 * whose member was never started, a submitted root before its verdict — are
 * `a6-process-restart.spec.ts`'s subject: they need runs, batches and a store, so
 * their child boots the whole deployment there.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SKILL_SIDECAR_FILE, loadSkillSidecar, serializeSkillSidecar } from '../../task-runtime/src/index.ts'
import type { CapabilityConfig } from '../../task-runtime/src/index.ts'
import { EvolutionService } from '../../evolution/src/index.ts'
import type { Config, GateAnswers, ProposeInput } from '../../evolution/src/index.ts'
import { capabilityRowText } from '../../evolution/src/capability-config.ts'
import { modelSelectionOf } from '../../evolution/src/replay.ts'
import type { SkillSidecar } from '../../task-runtime/src/index.ts'
import { recordCapabilityExperiment } from '../../evolution/tests/unit/fixtures/capability-experiment.ts'
import type { CapabilityExperimentStore, RecordedCapabilityExperiment } from '../../evolution/tests/unit/fixtures/capability-experiment.ts'
import { writeCapabilityConfig } from '../support/capability-config.ts'
import { assertRealDeath, dieHere, spawnSelfChild, type DeathMarker } from '../support/process-death.ts'

const ACTOR = 'root-1'
const PROPOSAL = 'p-joint'
/** The verifier vocabulary the fixture context reports, as a real registry lists its built-ins. */
const VERIFIER_VOCABULARY = ['command', 'composite', 'review']

/** The row the deployment already holds, the guidance skill it grants, and the tool plane it authorizes. */
const STORE_ROW = 'a6-joint-store'
const STORE_SKILL = 'a6-joint-guidance'
const STORE_ENTRY: CapabilityConfig = { skills: [STORE_SKILL], tools: ['filesystem', 'bash'] }
/** The row the joint commit installs, and the new execution skill it grants. */
const ROW = 'a6-joint-row'
const SKILL = 'a6-joint-skill'
const SELECTION = { provider: 'p', model: 'm' }
const ROW_ENTRY: CapabilityConfig = { skills: [SKILL], tools: ['filesystem'] }

/** The file a child writes its pid and boundary into before it dies; the parent's proof of which image died. */
const MARKER = 'a6-joint-death.json'
/** The one case a nested run is filtered to; no other case of this file runs there. */
const CHILD_CASE = 'the child process is killed at its armed commit window'
/** The environment variable that tells the nested run which window to die at. */
const BOUNDARY_ENV = 'A6_JOINT_BOUNDARY'
const BOUNDARY = process.env[BOUNDARY_ENV] as Boundary | undefined
const CHILD_DIR = process.env.A6_CHILD_WORKSPACE

/** The five durable windows of one joint capability commit, in the order they happen. */
type Boundary = 'intent-recorded' | 'files-written' | 'registry-row' | 'table-text' | 'completion-pending'
const BOUNDARIES: readonly Boundary[] = ['intent-recorded', 'files-written', 'registry-row', 'table-text', 'completion-pending']

/** A loadable `SKILL.md`: the frontmatter the loader requires, plus the body this candidate is about. */
function skillText(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: an A6 joint-commit fixture skill\n---\n\n${body}\n`
}

const CANDIDATE_TEXT = skillText(SKILL, '# the new execution skill')

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The execution declaration of the new skill, with the content identity of `content`. */
function executionSidecar(content: string): SkillSidecar {
  return {
    contractVersion: 1,
    type: 'execution',
    capabilities: [ROW],
    precondition: 'the fixture gap is present',
    inputs: [],
    outputs: [],
    requiredTools: ['read', 'write'],
    verifier: { ref: 'command' },
    content: { skillMdSha256: sha256Hex(content), resources: [] },
  } as SkillSidecar
}

const proposal: ProposeInput = {
  proposalId: PROPOSAL,
  targetType: 'capability',
  targetId: ROW,
  baseVersion: 'v1',
  level: 'L2',
  rationale: 'the deployment grants no capability for the member the junction is about',
  sourceRefs: ['diagnosis:d-joint'],
}

/** The six answers a capability gate is closed with, over the report the fixture recorded. */
function gateAnswers(refs: string[]): GateAnswers {
  return {
    targetFailureFixed: 'the fixture failure is fixed by the candidate',
    originalAcceptanceMaintained: 'the acceptance identity is unchanged',
    existingRegressionMaintained: 'the holdout still passes',
    noUnacceptableSideEffects: 'one row and one new skill directory',
    holdoutPerformanceAcceptable: 'the held-out case still passes',
    resourceCostAcceptable: 'recorded, not inferred',
    regressionEvidenceRefs: refs,
  }
}

/**
 * The deployment context one image boots with: the capability table it resolves
 * against (the runtime's own seam), the store the promotion re-reads, the session
 * logs the sides' requests are read from, and the verifier vocabulary. Declared
 * structurally — the service consults `optionalService` — so one boot in either
 * process is the same deployment shape, with the *durable* pieces on disk.
 */
function deploymentContext(input: {
  registry: Record<string, CapabilityConfig>
  rows: CapabilityExperimentStore
  sessions: Map<string, SessionEvent[]>
}): unknown {
  const { registry, rows, sessions } = input
  return {
    reflect: { provide: () => {} },
    effect: () => {},
    taskRuntime: {
      listCapabilities: () => structuredClone(registry),
      applyCapabilityRow: async (name: string, entry: CapabilityConfig | null) => {
        if (entry === null) delete registry[name]
        else registry[name] = structuredClone(entry)
      },
    },
    task: { openStore: async () => ({ ...rows, diagnoses: [], obligations: [] }) },
    sessionQuery: {
      readSession: async (sessionId: string) => {
        const events = sessions.get(sessionId)
        if (events === undefined) throw new Error(`missing session ${sessionId}`)
        return { session: { id: sessionId }, inheritedEventCount: 0, events }
      },
    },
    verifier: {
      ready: async () => {},
      verifierIds: () => [...VERIFIER_VOCABULARY],
      verifierVersions: () => Object.fromEntries(VERIFIER_VOCABULARY.map(id => [id, '1'])),
    },
  } as never
}

/** The empty store one boot's rows live in, and the session logs its sides' requests land in. */
function emptyStore(): CapabilityExperimentStore {
  return { tasks: [], runs: [], reviews: [], evidence: [] }
}

/** The directory one case's two images share: the ledger, the production skill root, the table file. */
async function sharedDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'a6-joint-'))
  directories.push(directory)
  return directory
}

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** One image's deployment: the service over the shared directory, its probes, and the table it resolves. */
function deployment(input: {
  directory: string
  registry: Record<string, CapabilityConfig>
  rows?: CapabilityExperimentStore
  sessions?: Map<string, SessionEvent[]>
  commitProbe?: Config['commitProbe']
  capabilityConfigProbe?: Config['capabilityConfigProbe']
}): { svc: EvolutionService; skillRoot: string; configFile: string; registry: Record<string, CapabilityConfig>; rows: CapabilityExperimentStore; sessions: Map<string, SessionEvent[]> } {
  const rows = input.rows ?? emptyStore()
  const sessions = input.sessions ?? new Map<string, SessionEvent[]>()
  const skillRoot = join(input.directory, 'skills')
  const configFile = join(input.directory, 'config.yml')
  const svc = new EvolutionService(deploymentContext({ registry: input.registry, rows, sessions }) as never, {
    root: join(input.directory, 'evolution'),
    skillRoot,
    modelSelection: () => modelSelectionOf(SELECTION)!,
    capabilityConfig: configFile,
    ...(input.commitProbe === undefined ? {} : { commitProbe: input.commitProbe }),
    ...(input.capabilityConfigProbe === undefined ? {} : { capabilityConfigProbe: input.capabilityConfigProbe }),
  })
  return { svc, skillRoot, configFile, registry: input.registry, rows, sessions }
}

/**
 * The promotion the commit stands on: the candidate proposed, materialized and
 * decided through the service's own entries, over the experiment the fixture
 * records. The commit itself is the caller's next call — the one the armed
 * boundary interrupts.
 */
async function walkToDecided(input: {
  svc: EvolutionService
  directory: string
  skillRoot: string
  registry: Record<string, CapabilityConfig>
  rows: CapabilityExperimentStore
  sessions: Map<string, SessionEvent[]>
}): Promise<RecordedCapabilityExperiment> {
  const { svc, directory, skillRoot, registry, rows, sessions } = input
  await svc.propose(proposal, ACTOR)
  await svc.candidate(PROPOSAL, { capabilityTable: 'config.yml#doc' }, ACTOR, {
    rows: { [ROW]: { ...ROW_ENTRY } },
    skill: { name: SKILL, content: CANDIDATE_TEXT, sidecar: executionSidecar(CANDIDATE_TEXT) },
  })
  await svc.prepare(PROPOSAL, ACTOR)
  const workspace = join(directory, 'snapshot')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'input.txt'), 'the frozen input\n', 'utf8')
  const experiment = await recordCapabilityExperiment(svc, {
    root: join(directory, 'evolution'),
    skillRoot,
    registry,
    rows,
    sessions,
    workspace,
    selection: modelSelectionOf(SELECTION)!,
  }, await svc.get(PROPOSAL))
  await svc.gate(PROPOSAL, gateAnswers([experiment.reportPath]), ACTOR)
  await svc.decide(PROPOSAL, 'PROMOTE', ACTOR, 'approval:decide')
  return experiment
}

/** The ledger's own lines, read from the file — never from a service's memory. */
async function ledgerLines(directory: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(directory, 'evolution', 'proposals.jsonl'), 'utf8').catch(() => '')
  return text.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
}

/** The row's own text inside the deployment's table file: what a restarting deployment loads. */
async function tableRowText(configFile: string, name: string): Promise<string | null> {
  return capabilityRowText(await readFile(configFile, 'utf8'), 'config.yml#doc', name)
}

/** The table a restart loads, read from the file rather than from any process's memory. */
async function tableFromFile(configFile: string): Promise<Record<string, CapabilityConfig>> {
  const restarted: Record<string, CapabilityConfig> = { [STORE_ROW]: STORE_ENTRY }
  if (await tableRowText(configFile, ROW) !== null) restarted[ROW] = ROW_ENTRY
  return restarted
}

/** The production skill object's bytes, or `undefined` when the directory is not there. */
async function productionSkill(skillRoot: string, name: string): Promise<{ md: string; sidecar: string } | undefined> {
  const directory = join(skillRoot, name)
  if (!existsSync(directory)) return undefined
  const [md, sidecar] = await Promise.all([
    readFile(join(directory, 'SKILL.md'), 'utf8'),
    readFile(join(directory, SKILL_SIDECAR_FILE), 'utf8'),
  ])
  return { md, sidecar }
}

/** Start one child that commits at `boundary` and dies there. */
function deathAt(directory: string, boundary: Boundary) {
  return spawnSelfChild({
    specPath: SPEC_PATH,
    caseName: CHILD_CASE,
    workspace: directory,
    env: { [BOUNDARY_ENV]: boundary },
  })
}

/** This spec's own file — the one file a nested run collects, where the outer run's file is. */
const SPEC_PATH = fileURLToPath(import.meta.url)

describe.skipIf(BOUNDARY !== undefined)('A6 EVO-4 (real death): the joint commit is killed at each durable window, and a new process settles it', () => {
  it.each(BOUNDARIES)('leaves the boundary\'s own durable state after a death at %s, and reconciles it in the new process', async boundary => {
    const directory = await sharedDirectory()
    await writeCapabilityConfig(join(directory, 'config.yml'), { [STORE_ROW]: STORE_ENTRY })
    await mkdir(join(directory, 'skills'), { recursive: true })

    const child = deathAt(directory, boundary)
    const marker = await assertRealDeath<DeathMarker & { boundary: Boundary }>(directory, MARKER, child)
    expect(marker.boundary).toBe(boundary)

    // ── what the killed image left, read off the ledger file ──────────────────
    const lines = await ledgerLines(directory)
    expect(lines.filter(line => line.kind === 'commit_intent')).toHaveLength(1)
    expect([...lines].reverse().find(line => ['applied', 'rolledback'].includes(String(line.kind)))).toBeUndefined()
    const intent = lines.filter(line => line.kind === 'commit_intent')[0]!
    expect(intent).toMatchObject({ proposalId: PROPOSAL, direction: 'apply', approvalRef: 'approval:apply' })

    // ── what the provider side holds: the object, and whether anything grants it ─
    const configFile = join(directory, 'config.yml')
    const skillRoot = join(directory, 'skills')
    const object = await productionSkill(skillRoot, SKILL)
    const rowText = await tableRowText(configFile, ROW)
    if (boundary === 'intent-recorded') {
      // Only the record exists: production is exactly the state before the commit.
      expect(object).toBeUndefined()
      expect(rowText).toBeNull()
    } else {
      // Both files are in place (the last window is after the last rename), and the
      // object a loader reads is the complete candidate — never a partial one.
      expect(object?.md).toBe(CANDIDATE_TEXT)
      expect(object?.sidecar).toBe(serializeSkillSidecar(executionSidecar(CANDIDATE_TEXT)))
      const loaded = await loadSkillSidecar(join(skillRoot, SKILL))
      expect(loaded.defects).toEqual([])
      expect(loaded.sidecar?.type).toBe('execution')
      expect(loaded.sidecar?.content.skillMdSha256).toBe(sha256Hex(CANDIDATE_TEXT))
      // Whether the *table a restart loads* grants it is what the window decides: the
      // row is written into the file only after the registry's own write, so a death
      // in between leaves the half-product — an object on disk that nothing grants.
      if (boundary === 'files-written' || boundary === 'registry-row') expect(rowText).toBeNull()
      else expect(rowText).not.toBeNull()
    }

    // ── the reopen: a new process boots the same directory ───────────────────
    const restarted = deployment({ directory, registry: await tableFromFile(configFile) })
    // The table is what the file holds — the row is granted only from the window that
    // wrote it, and the open intent is visible either way.
    expect(restarted.registry[ROW] === undefined).toBe(rowText === null)
    expect((await restarted.svc.get(PROPOSAL)).status).toBe('decided')
    expect((await restarted.svc.openIntentTargets()).length).toBeGreaterThan(0)

    // The reconciliation a restart runs settles it: exactly one completion, the row
    // in the table it loads next time, the object in production, and the intent gone.
    const outcomes = await restarted.svc.reconcile()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.result, outcomes[0]!.detail ?? '').toContain('completed')
    const settled = await ledgerLines(directory)
    expect(settled.filter(line => line.kind === 'applied')).toHaveLength(1)
    expect(settled.filter(line => line.kind === 'commit_intent')).toHaveLength(1)
    expect(await restarted.svc.openIntentTargets()).toEqual([])
    expect((await restarted.svc.get(PROPOSAL)).status).toBe('applied')
    expect(await tableRowText(configFile, ROW)).not.toBeNull()
    expect((await productionSkill(skillRoot, SKILL))?.md).toBe(CANDIDATE_TEXT)
    // …and a second reconciliation is free: nothing is owed any more.
    const stable = await readFile(join(directory, 'evolution', 'proposals.jsonl'), 'utf8')
    expect(await restarted.svc.reconcile()).toEqual([])
    expect(await readFile(join(directory, 'evolution', 'proposals.jsonl'), 'utf8')).toBe(stable)

    // The deployment that boots next loads the applied row from the file and grants it.
    const next = deployment({ directory, registry: await tableFromFile(configFile) })
    expect(next.registry[ROW]).toEqual(ROW_ENTRY)
  }, 120_000)
})

/**
 * The nested child: skipped unless its parent armed it (so an ordinary suite can
 * never kill a process, whatever it runs). It boots its own deployment over the
 * shared directory, walks the proposal to `decided`, records the boundary it is
 * about to die at, and lets `apply` run into the armed window — where the probe
 * kills this process image. Everything below that call is dead code.
 */
describe.skipIf(BOUNDARY === undefined)('A6 EVO-4 (nested child): the process image that dies inside the joint commit', () => {
  it(CHILD_CASE, async () => {
    const boundary = BOUNDARY!
    const directory = CHILD_DIR
    if (directory === undefined) throw new Error('the child case runs only under the env its parent sets: A6_CHILD_WORKSPACE is missing')
    const armed = boundary
    const restarted = deployment({
      directory,
      registry: { [STORE_ROW]: STORE_ENTRY },
      commitProbe: (stage, target) => {
        if (armed === 'intent-recorded' && stage === 'intent-recorded') dieHere(armed)
        if (armed === 'files-written' && stage === 'write-renamed' && target?.endsWith(SKILL_SIDECAR_FILE) === true) dieHere(armed)
        if (armed === 'completion-pending' && stage === 'commit-verified') dieHere(armed)
      },
      capabilityConfigProbe: stage => {
        if (armed === 'registry-row' && stage === 'before-write') dieHere(armed)
        if (armed === 'table-text' && stage === 'written') dieHere(armed)
      },
    })
    await walkToDecided({ ...restarted, directory })
    // The boundary this image is about to die at, and the pid that will be gone.
    await writeFile(join(directory, MARKER), `${JSON.stringify({ pid: process.pid, boundary }, null, 2)}\n`, 'utf8')
    await restarted.svc.apply(PROPOSAL, ACTOR, 'approval:apply')
  }, 120_000)
})
