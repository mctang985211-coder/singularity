/**
 * A6 interface ①: the capability candidate — exactly one capability row, plus an
 * optional new execution skill — through the evolution package's real public
 * entries (`propose` → `candidate` → `prepare` → `gate` → `decide` → `apply` /
 * `rollback`), on the K2/K3 commit path, against a registry that really changes.
 *
 * Every case goes through the service, never a private helper: the refusals are
 * the service's, the commit is the service's, and "the registry moved" is read
 * back from the registry the fixture owns.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityConfig, SkillSidecar } from '@dangosys/dsh-singularity-task-runtime'
import { SKILL_SIDECAR_FILE, serializeSkillSidecar } from '@dangosys/dsh-singularity-task-runtime'
import { EvolutionService } from '../../src/evolution.ts'
import type { Config, GateAnswers, ProposeInput } from '../../src/evolution.ts'
import type { CommitStage } from '../../src/commit.ts'
import { capabilityOverlay } from '../../src/capability-candidate.ts'
import { modelSelectionOf } from '../../src/replay.ts'
import { writeCapabilityConfig } from '../../../tests/support/capability-config.ts'
import { recordCapabilityExperiment } from './fixtures/capability-experiment.ts'
import type { CapabilityExperimentStore, RecordedCapabilityExperiment } from './fixtures/capability-experiment.ts'

/** The verifier vocabulary every fixture context reports, as a real registry lists its built-ins. */
const VERIFIER_VOCABULARY = ['command', 'composite', 'review']

/** The row the store already holds, the guidance skill it grants, and the tool plane it authorizes (filesystem → read/write/edit). */
const STORE_ROW = 'a6-fixture-store'
const STORE_SKILL = 'a6-existing-guidance'
const STORE_ENTRY: CapabilityConfig = { skills: [STORE_SKILL], tools: ['filesystem', 'bash'] }

/** The row a candidate writes, and the new skill it grants. */
const NEW_ROW = 'a6-fixture-capability'
const NEW_SKILL = 'a6-fixture-skill'

const SELECTION = { provider: 'p', model: 'm' }

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A loadable `SKILL.md`: the frontmatter the loader requires, plus the body the case is about. */
function skillText(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: an A6 capability-candidate fixture skill\n---\n\n${body}\n`
}

/** The body every default fixture candidate declares. */
const CANDIDATE_BODY = '# the new execution skill'
const CANDIDATE_TEXT = skillText(NEW_SKILL, CANDIDATE_BODY)

/** The execution declaration of the new skill, with the content identity of `content`. */
function executionSidecar(
  content: string,
  overrides: { capabilities?: string[]; requiredTools?: string[]; verifier?: { ref: string }; resources?: { path: string; sha256: string }[]; type?: string } = {},
): SkillSidecar {
  return {
    contractVersion: 1,
    type: overrides.type ?? 'execution',
    capabilities: overrides.capabilities ?? [NEW_ROW],
    precondition: 'the fixture gap is present',
    inputs: [],
    outputs: [],
    requiredTools: overrides.requiredTools ?? ['read', 'write'],
    verifier: overrides.verifier ?? { ref: 'command' },
    content: { skillMdSha256: sha256Hex(content), resources: overrides.resources ?? [] },
  } as SkillSidecar
}

/** One capability mutation: exactly one whole row, plus the new skill it grants. */
function capabilityMutation(options: {
  rows?: unknown
  skill?: unknown
  entry?: CapabilityConfig
  content?: string
} = {}): unknown {
  const content = options.content ?? CANDIDATE_TEXT
  const mutation: Record<string, unknown> = {
    rows: 'rows' in options ? options.rows : { [NEW_ROW]: options.entry ?? { skills: [NEW_SKILL], tools: ['filesystem'] } },
  }
  if ('skill' in options) mutation.skill = options.skill
  else mutation.skill = { name: NEW_SKILL, content, sidecar: executionSidecar(content) }
  return mutation
}

const capabilityProposal: ProposeInput = {
  proposalId: 'cap1',
  targetType: 'capability',
  targetId: NEW_ROW,
  baseVersion: 'v1',
  level: 'L2',
  rationale: 'the store has no capability that grants the new execution skill',
  sourceRefs: ['diagnosis:d1'],
}

const VERSION_SET = { capabilityTable: 'config.yml#doc1' }

function gateAnswers(refs: string[]): GateAnswers {
  return {
    targetFailureFixed: 'the fixture gap is closed by the new provider',
    originalAcceptanceMaintained: 'original criteria unchanged and green',
    existingRegressionMaintained: 'the regression suite replayed green',
    noUnacceptableSideEffects: 'one row and one new skill directory',
    holdoutPerformanceAcceptable: 'held-out fixtures pass',
    resourceCostAcceptable: 'same runtime as the baseline',
    regressionEvidenceRefs: refs,
  }
}

/**
 * One fixture deployment: the ledger root, the production skill root, the pinned
 * skill home discovery reads, and the capability registry the runtime holds.
 * The registry is the fixture's own object, so a case can change a row behind
 * the service's back (the third-party change) and read back what a commit
 * really did with it.
 */
async function fixture(options: {
  registry?: Record<string, CapabilityConfig>
  commitProbe?: (stage: CommitStage, target?: string) => void
  /** The table file's own write seam (`Config.capabilityConfigProbe`): throwing stops the commit exactly where it stands. */
  capabilityConfigProbe?: (stage: 'before-write' | 'written', row: string) => void
  installProductionSkill?: boolean
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'evolution-capability-'))
  const root = join(dir, 'evolution')
  const skillRoot = join(dir, 'skills')
  const home = join(dir, 'home')
  await mkdir(join(home, 'skills', STORE_SKILL), { recursive: true })
  await writeFile(join(home, 'skills', STORE_SKILL, 'SKILL.md'), skillText(STORE_SKILL, '# the guidance the store already grants'))
  await mkdir(skillRoot, { recursive: true })
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('HOME', home)
  if (options.installProductionSkill === true) {
    await mkdir(join(skillRoot, NEW_SKILL), { recursive: true })
    await writeFile(join(skillRoot, NEW_SKILL, 'SKILL.md'), skillText(NEW_SKILL, '# already there'))
  }
  const registry: Record<string, CapabilityConfig> = options.registry ?? { [STORE_ROW]: STORE_ENTRY }
  const applies: { name: string; entry: CapabilityConfig | null }[] = []
  // The experiment evidence a promotion gate reads: the store rows the fixture
  // records through the service's own write path, and the session logs its sides'
  // requests are read from.
  const rows: CapabilityExperimentStore = { tasks: [], runs: [], reviews: [], evidence: [] }
  const sessions = new Map<string, SessionEvent[]>()
  const ctx = {
    reflect: { provide: () => {} },
    effect: () => {},
    taskRuntime: {
      listCapabilities: () => structuredClone(registry),
      applyCapabilityRow: async (name: string, entry: CapabilityConfig | null) => {
        applies.push({ name, entry: entry === null ? null : structuredClone(entry) })
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
  const config: Config = {
    root,
    skillRoot,
    modelSelection: () => SELECTION as never,
    // The capability table's own file (A6): the commit writes the row it installs
    // into this file before it records the completion, so a case reads back both
    // what the registry took and what a restart would load.
    capabilityConfig: await writeCapabilityConfig(join(dir, 'config.yml'), registry),
    ...(options.commitProbe === undefined ? {} : { commitProbe: options.commitProbe }),
    ...(options.capabilityConfigProbe === undefined ? {} : { capabilityConfigProbe: options.capabilityConfigProbe }),
  }
  const svc = new EvolutionService(ctx, config)
  return { svc, ctx, root, skillRoot, home, registry, applies, config, rows, sessions }
}

/**
 * The snapshot both experiment workspaces are built from, and the evidence a
 * capability promotion must rest on — recorded for the proposal as it stands
 * (A6: a PROMOTE with no such experiment is refused, so every case that walks
 * the lifecycle to `decided` records one).
 */
async function recordEvidence(
  fixture: CapabilityFixture,
  options: { baseline?: 'not-admitted' | 'reproduce' | 'verified' | 'failed'; candidate?: 'verified' | 'failed' } = {},
): Promise<RecordedCapabilityExperiment> {
  const workspace = join(fixture.root, 'snapshot')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'input.txt'), 'the frozen input\n')
  return recordCapabilityExperiment(fixture.svc, {
    root: fixture.root,
    skillRoot: fixture.skillRoot,
    registry: fixture.registry,
    rows: fixture.rows,
    sessions: fixture.sessions,
    workspace,
    selection: modelSelectionOf(SELECTION)!,
  }, await fixture.svc.get('cap1'), options)
}

/** The fixture one case works with: the service, its durable pieces, and the store the evidence lives in. */
type CapabilityFixture = {
  svc: EvolutionService
  ctx: unknown
  root: string
  skillRoot: string
  home: string
  registry: Record<string, CapabilityConfig>
  applies: { name: string; entry: CapabilityConfig | null }[]
  config: Config
  rows: CapabilityExperimentStore
  sessions: Map<string, SessionEvent[]>
}

/** The refusal message of one call, or `''` when it resolved. */
async function refusalOf(action: Promise<unknown>): Promise<string> {
  try {
    await action
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The ledger lines of one fixture's proposals.jsonl, parsed. */
async function ledgerLines(root: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(root, 'proposals.jsonl'), 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Walk a capability proposal to `decided` through the real entries: propose,
 * candidate, prepare, record the two-sided experiment the candidate was
 * evaluated by, gate, decide. The experiment is recorded between prepare and
 * gate because that is the order a live flow produces — evidence first, then the
 * human answers over it.
 */
async function capabilityDecided(
  fixture: CapabilityFixture,
  mutation: unknown = capabilityMutation(),
): Promise<void> {
  const { svc, skillRoot } = fixture
  await svc.propose(capabilityProposal, 'root-1')
  await svc.candidate('cap1', VERSION_SET, 'root-1', mutation)
  await svc.prepare('cap1', 'root-1')
  // The gate's answers rest on the experiment the candidate was evaluated by,
  // so the report it cites is the evidence the human answers over.
  const experiment = await recordEvidence(fixture)
  await svc.gate('cap1', gateAnswers([skillRoot, experiment.reportPath]), 'root-1')
  await svc.decide('cap1', 'PROMOTE', 'root-1', 'approval:decide')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('capability candidate: the whole chain', () => {
  it('prepares the frozen row and the new skill, applies both through one commit, and reads back', async () => {
    const f = await fixture()
    const { svc, ctx, root, skillRoot, registry, applies } = f
    await svc.propose(capabilityProposal, 'root-1')
    const recorded = await svc.candidate('cap1', VERSION_SET, 'root-1', capabilityMutation())
    expect(recorded.status).toBe('candidate')

    const prepared = await svc.prepare('cap1', 'root-1')
    expect(prepared.prepared!.capabilityRow!.name).toBe(NEW_ROW)
    expect(prepared.prepared!.capabilityRow!.digest).toMatch(/^[a-f0-9]{64}$/)
    // The store holds no row of that name: the baseline is the recorded absence.
    expect(prepared.prepared!.capabilityBaseline).toBeNull()
    // A new skill: the candidate object is frozen, production holds none.
    expect(prepared.prepared!.skillContent!.name).toBe(NEW_SKILL)
    expect(prepared.prepared!.skillBaseline).toBeNull()
    expect(prepared.prepared!.champion).toBe('absent')
    const sandbox = join(root, 'sandbox', 'cap1')
    expect(existsSync(join(sandbox, 'capability', `${NEW_ROW}.json`))).toBe(true)
    expect(existsSync(join(sandbox, 'skills', NEW_SKILL, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(sandbox, 'skills', NEW_SKILL, SKILL_SIDECAR_FILE))).toBe(true)

    const experiment = await recordEvidence(f)
    await svc.gate('cap1', gateAnswers([skillRoot, experiment.reportPath]), 'root-1')
    expect((await svc.decide('cap1', 'PROMOTE', 'root-1', 'approval:decide')).status).toBe('decided')

    const outcome = await svc.apply('cap1', 'root-1', 'approval:apply')
    expect(outcome.targets).toEqual([
      join(skillRoot, NEW_SKILL, 'SKILL.md'),
      join(skillRoot, NEW_SKILL, SKILL_SIDECAR_FILE),
    ])
    expect(await readFile(join(skillRoot, NEW_SKILL, 'SKILL.md'), 'utf8')).toBe(CANDIDATE_TEXT)
    expect(await readFile(join(skillRoot, NEW_SKILL, SKILL_SIDECAR_FILE), 'utf8'))
      .toBe(serializeSkillSidecar(executionSidecar(CANDIDATE_TEXT)))
    // The registry really moved, once, through the runtime's row seam.
    expect(registry[NEW_ROW]).toEqual({ skills: [NEW_SKILL], tools: ['filesystem'] })
    expect(applies).toEqual([{ name: NEW_ROW, entry: { skills: [NEW_SKILL], tools: ['filesystem'] } }])
    expect(registry[STORE_ROW]).toEqual(STORE_ENTRY)

    // The completion line closes the one intent and reports the file set it wrote.
    const lines = await ledgerLines(root)
    expect(lines.find(line => line.kind === 'commit_intent')).toMatchObject({
      intentId: 'cap1/apply',
      files: [
        { target: outcome.targets[0]!, baselineSha256: null, source: join('sandbox', 'cap1', 'skills', NEW_SKILL, 'SKILL.md') },
        { target: outcome.targets[1]!, baselineSha256: null, source: join('sandbox', 'cap1', 'skills', NEW_SKILL, SKILL_SIDECAR_FILE) },
      ],
      capability: {
        name: NEW_ROW,
        baselineSha256: null,
        contentSha256: prepared.prepared!.capabilityRow!.digest,
        source: join('sandbox', 'cap1', 'capability', `${NEW_ROW}.json`),
      },
    })
    expect(lines.find(line => line.kind === 'applied')).toMatchObject({
      proposalId: 'cap1',
      intentId: 'cap1/apply',
      approvalRef: 'approval:apply',
      targets: outcome.targets,
    })

    // Reopened: the state is the ledger's, and there is nothing to reconcile.
    const reopened = new EvolutionService(ctx, { root, skillRoot, modelSelection: () => SELECTION as never })
    expect((await reopened.get('cap1')).status).toBe('applied')
    expect(await reopened.reconcile()).toEqual([])
    expect(await reopened.openIntentTargets()).toEqual([])
  })

  it('reads the prepared identity and the overlay input the evaluation runner mounts back out', async () => {
    const { svc, root } = await fixture()
    await svc.propose(capabilityProposal, 'root-1')
    await svc.candidate('cap1', VERSION_SET, 'root-1', capabilityMutation())
    const prepared = await svc.prepare('cap1', 'root-1')
    expect(capabilityOverlay(prepared, { root })).toEqual({
      capabilityOverrides: { [NEW_ROW]: { skills: [NEW_SKILL], tools: ['filesystem'] } },
      extraSkillRoots: [join(root, 'sandbox', 'cap1', 'skills')],
    })
  })

  it('walks a row-only candidate — no new skill — through apply and rollback as one row commit', async () => {
    // L1: the candidate composes capabilities the store already grants, so its
    // whole commit is the one row and no file at all.
    const f = await fixture()
    const { svc, root, skillRoot, registry } = f
    const mutation = capabilityMutation({ entry: { skills: ['a6-existing-guidance'], tools: ['filesystem'] }, skill: undefined })
    await svc.propose(capabilityProposal, 'root-1')
    await svc.candidate('cap1', VERSION_SET, 'root-1', mutation)
    const prepared = await svc.prepare('cap1', 'root-1')
    expect(prepared.prepared!.capabilityRow!.entry).toEqual({ skills: ['a6-existing-guidance'], tools: ['filesystem'] })
    expect(prepared.prepared!.skillContent).toBeUndefined()
    expect(prepared.prepared!.skillBaseline).toBeUndefined()
    expect(prepared.prepared!.champion).toBe('absent')
    expect(existsSync(join(root, 'sandbox', 'cap1', 'skills'))).toBe(false)
    expect(capabilityOverlay(prepared, { root })).toEqual({
      capabilityOverrides: { [NEW_ROW]: { skills: ['a6-existing-guidance'], tools: ['filesystem'] } },
      extraSkillRoots: [],
    })

    const experiment = await recordEvidence(f)
    await svc.gate('cap1', gateAnswers([skillRoot, experiment.reportPath]), 'root-1')
    await svc.decide('cap1', 'PROMOTE', 'root-1', 'approval:decide')
    const outcome = await svc.apply('cap1', 'root-1', 'approval:apply')
    expect(outcome.targets).toEqual([])
    expect(registry[NEW_ROW]).toEqual({ skills: ['a6-existing-guidance'], tools: ['filesystem'] })
    const applied = (await ledgerLines(root)).find(line => line.kind === 'applied')!
    expect(applied).toMatchObject({ intentId: 'cap1/apply', targets: [] })

    expect((await svc.rollback('cap1', 'root-1', 'approval:rollback')).targets).toEqual([])
    expect(registry[NEW_ROW]).toBeUndefined()
    expect(registry[STORE_ROW]).toEqual(STORE_ENTRY)
    expect((await ledgerLines(root)).find(line => line.kind === 'rolledback')).toMatchObject({
      intentId: 'cap1/rollback',
      targets: [],
    })
  })

  it('rolls a newly added row back: the row is gone, the skill files are gone, nothing else moved', async () => {
    const f = await fixture()
    const { svc, skillRoot, registry } = f
    // A production object this candidate never touches.
    await mkdir(join(skillRoot, 'a6-untouched'), { recursive: true })
    await writeFile(join(skillRoot, 'a6-untouched', 'SKILL.md'), 'untouched\n')
    await capabilityDecided(f)
    await svc.apply('cap1', 'root-1', 'approval:apply')
    expect(registry[NEW_ROW]).toBeDefined()

    const rolled = await svc.rollback('cap1', 'root-1', 'approval:rollback')
    expect(rolled.targets).toEqual([
      join(skillRoot, NEW_SKILL, 'SKILL.md'),
      join(skillRoot, NEW_SKILL, SKILL_SIDECAR_FILE),
    ])
    expect(registry[NEW_ROW]).toBeUndefined()
    expect(registry[STORE_ROW]).toEqual(STORE_ENTRY)
    expect(existsSync(join(skillRoot, NEW_SKILL))).toBe(false)
    // The file that existed before this candidate is not deleted.
    expect(await readFile(join(skillRoot, 'a6-untouched', 'SKILL.md'), 'utf8')).toBe('untouched\n')
    const lines = await ledgerLines(f.root)
    expect(lines.filter(line => line.kind === 'commit_intent').at(-1)!.intentId).toBe('cap1/rollback')
    expect(lines.find(line => line.kind === 'rolledback')).toMatchObject({ intentId: 'cap1/rollback', targets: rolled.targets })
  })

  it('rolls a replaced row back to the exact row the store held before the candidate', async () => {
    const previous: CapabilityConfig = { skills: ['a6-fixture-guidance'], tools: ['filesystem'] }
    const f = await fixture({ registry: { [STORE_ROW]: STORE_ENTRY, [NEW_ROW]: previous } })
    const { svc, skillRoot, registry } = f
    await svc.propose(capabilityProposal, 'root-1')
    await svc.candidate('cap1', VERSION_SET, 'root-1', capabilityMutation())
    const prepared = await svc.prepare('cap1', 'root-1')
    expect(prepared.prepared!.capabilityBaseline).toMatchObject({ name: NEW_ROW })
    expect(prepared.prepared!.skillBaseline).toBeNull()
    // The production table holds the row this candidate replaces, so its
    // baseline really runs: the observed failure reproduces and the holdout
    // stays green, and the candidate has to fix the one without degrading the
    // other.
    const experiment = await recordEvidence(f, { baseline: 'reproduce' })
    await svc.gate('cap1', gateAnswers([skillRoot, experiment.reportPath]), 'root-1')
    await svc.decide('cap1', 'PROMOTE', 'root-1', 'approval:decide')
    await svc.apply('cap1', 'root-1', 'approval:apply')
    expect(registry[NEW_ROW]).toEqual({ skills: [NEW_SKILL], tools: ['filesystem'] })

    await svc.rollback('cap1', 'root-1', 'approval:rollback')
    expect(registry[NEW_ROW]).toEqual(previous)
    expect(existsSync(join(skillRoot, NEW_SKILL))).toBe(false)
  })
})

describe('capability candidate: named refusals, zero writes', () => {
  it.each([
    ['two rows', capabilityMutation({ rows: { [NEW_ROW]: { skills: [NEW_SKILL] }, other: { skills: ['a6-fixture-guidance'] } } }), 'capability-row-multiple'],
    ['zero rows', capabilityMutation({ rows: {} }), 'capability-row-missing'],
    ['no rows at all', capabilityMutation({ rows: undefined }), 'capability-row-missing'],
    ['rows that are not an object', capabilityMutation({ rows: ['x'] }), 'capability-row-missing'],
    ['a row that is not a row', capabilityMutation({ entry: { skills: [NEW_SKILL], tools: 7 } as never }), 'capability-row-invalid'],
    [
      'declared resources',
      capabilityMutation({
        skill: { name: NEW_SKILL, content: CANDIDATE_TEXT, sidecar: executionSidecar(CANDIDATE_TEXT, { resources: [{ path: 'scripts/run.sh', sha256: 'a'.repeat(64) }] }) },
      }),
      'skill-resources-nonempty',
    ],
    [
      'a knowledge declaration',
      capabilityMutation({
        skill: {
          name: NEW_SKILL,
          content: CANDIDATE_TEXT,
          sidecar: {
            contractVersion: 1,
            type: 'knowledge',
            source: 'a fixture',
            scope: 'nothing',
            content: { skillMdSha256: sha256Hex(CANDIDATE_TEXT), resources: [] },
            contentCheck: { kind: 'command', command: 'true' },
          },
        },
      }),
      'skill-sidecar-not-execution',
    ],
    [
      'a declaration that does not name the row',
      capabilityMutation({
        skill: { name: NEW_SKILL, content: CANDIDATE_TEXT, sidecar: executionSidecar(CANDIDATE_TEXT, { capabilities: ['a6-some-other-row'] }) },
      }),
      'skill-capabilities-missing-row',
    ],
    [
      'a content identity that is not the submitted SKILL.md',
      capabilityMutation({ skill: { name: NEW_SKILL, content: CANDIDATE_TEXT, sidecar: executionSidecar(skillText('other', 'x')) } }),
      'skill-content-mismatch',
    ],
    [
      'a declaration the loader cannot read',
      capabilityMutation({ skill: { name: NEW_SKILL, content: CANDIDATE_TEXT, sidecar: { ...executionSidecar(CANDIDATE_TEXT), extra: 1 } } }),
      'skill-sidecar-invalid',
    ],
    [
      'a row that grants no skill the candidate carries',
      capabilityMutation({ entry: { skills: ['a6-fixture-guidance'], tools: ['filesystem'] } }),
      'capability-row-grants-no-skill',
    ],
  ] as const)('refuses %s before the first ledger line, zero writes', async (_label, mutation, code) => {
    const { svc, root, skillRoot, registry } = await fixture()
    await svc.propose(capabilityProposal, 'root-1')
    const message = await refusalOf(svc.candidate('cap1', VERSION_SET, 'root-1', mutation))
    expect(message).toContain(code)
    expect((await svc.get('cap1')).status).toBe('proposed')
    expect((await ledgerLines(root)).some(line => line.kind === 'candidate')).toBe(false)
    expect(registry[NEW_ROW]).toBeUndefined()
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
    expect(existsSync(join(skillRoot, NEW_SKILL))).toBe(false)
  })

  it.each([
    [
      'a tool the store does not authorize',
      capabilityMutation({ entry: { skills: [NEW_SKILL], tools: ['filesystem', 'subagent'] }, skill: undefined }),
      'capability-new-tool',
    ],
    [
      'a preset on a new row',
      capabilityMutation({ entry: { skills: [NEW_SKILL], tools: ['filesystem'], preset: 'standard' }, skill: undefined }),
      'capability-policy-change',
    ],
    [
      'an unregistered verifier',
      capabilityMutation({
        skill: { name: NEW_SKILL, content: CANDIDATE_TEXT, sidecar: executionSidecar(CANDIDATE_TEXT, { verifier: { ref: 'a6-not-registered' } }) },
      }),
      'skill-verifier-unregistered',
    ],
    [
      'required tools the store does not authorize',
      capabilityMutation({
        skill: { name: NEW_SKILL, content: CANDIDATE_TEXT, sidecar: executionSidecar(CANDIDATE_TEXT, { requiredTools: ['read', 'web_fetch'] }) },
      }),
      'skill-tool-unauthorized',
    ],
  ] as const)('refuses %s at prepare, zero writes', async (_label, mutation, code) => {
    const { svc, root, skillRoot, registry } = await fixture()
    await svc.propose(capabilityProposal, 'root-1')
    await svc.candidate('cap1', VERSION_SET, 'root-1', mutation)
    const message = await refusalOf(svc.prepare('cap1', 'root-1'))
    expect(message).toContain(code)
    expect((await svc.get('cap1')).status).toBe('candidate')
    expect(registry[NEW_ROW]).toBeUndefined()
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
    expect(existsSync(join(skillRoot, NEW_SKILL))).toBe(false)
    expect((await ledgerLines(root)).some(line => line.kind === 'prepared')).toBe(false)
  })

  it('refuses a new skill whose name is already a production object, by name and with nothing written', async () => {
    const { svc, root, skillRoot, registry } = await fixture({ installProductionSkill: true })
    await svc.propose(capabilityProposal, 'root-1')
    await svc.candidate('cap1', VERSION_SET, 'root-1', capabilityMutation())
    const message = await refusalOf(svc.prepare('cap1', 'root-1'))
    expect(message).toContain('skill-name-taken')
    expect(await readFile(join(skillRoot, NEW_SKILL, 'SKILL.md'), 'utf8')).toBe(skillText(NEW_SKILL, '# already there'))
    expect(registry[NEW_ROW]).toBeUndefined()
    expect(existsSync(join(root, 'sandbox', 'cap1'))).toBe(false)
  })

  it('refuses a rename of an existing production object instead of letting it bypass the same-name path', async () => {
    const { svc, root, skillRoot } = await fixture()
    // A production skill whose body the candidate copies under a new name: the
    // frontmatter is rewritten, the skill it duplicates is not.
    await mkdir(join(skillRoot, 'a6-existing-skill'), { recursive: true })
    await writeFile(join(skillRoot, 'a6-existing-skill', 'SKILL.md'), skillText('a6-existing-skill', CANDIDATE_BODY))
    const content = skillText(NEW_SKILL, CANDIDATE_BODY)
    await svc.propose(capabilityProposal, 'root-1')
    await svc.candidate('cap1', VERSION_SET, 'root-1', capabilityMutation({ content, skill: { name: NEW_SKILL, content, sidecar: executionSidecar(content) } }))
    const message = await refusalOf(svc.prepare('cap1', 'root-1'))
    expect(message).toContain('skill-renamed-production')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
  })

  it('refuses a candidate whose SKILL.md frontmatter names another skill, and leaves no sandbox behind', async () => {
    const { svc, root, registry } = await fixture()
    const content = skillText('a6-some-other-name', CANDIDATE_BODY)
    await svc.propose(capabilityProposal, 'root-1')
    await svc.candidate('cap1', VERSION_SET, 'root-1', capabilityMutation({ content, skill: { name: NEW_SKILL, content, sidecar: executionSidecar(content) } }))
    const message = await refusalOf(svc.prepare('cap1', 'root-1'))
    expect(message).toContain('skill-name-mismatch')
    expect(registry[NEW_ROW]).toBeUndefined()
    // The sandbox the check needed is removed with the refusal: nothing of this
    // candidate survives it.
    expect(existsSync(join(root, 'sandbox', 'cap1'))).toBe(false)
    expect((await ledgerLines(root)).some(line => line.kind === 'prepared')).toBe(false)
  })
})

describe('capability candidate: third-party change and half-products', () => {
  it('refuses apply when the registry row moved after the decision, with no side effect', async () => {
    const f = await fixture()
    const { svc, skillRoot, registry } = f
    await capabilityDecided(f)
    registry[NEW_ROW] = { skills: ['a-moved-in-row'] }
    const message = await refusalOf(svc.apply('cap1', 'root-1', 'approval:apply'))
    expect(message).toContain('capability-registry-changed')
    expect(registry[NEW_ROW]).toEqual({ skills: ['a-moved-in-row'] })
    expect(existsSync(join(skillRoot, NEW_SKILL))).toBe(false)
    const lines = await ledgerLines(f.root)
    expect(lines.some(line => line.kind === 'commit_intent')).toBe(false)
    expect(lines.some(line => line.kind === 'applied')).toBe(false)
  })

  it('refuses apply when the new skill name appeared in production after the decision, with no side effect', async () => {
    const f = await fixture()
    const { svc, skillRoot, registry } = f
    await capabilityDecided(f)
    await mkdir(join(skillRoot, NEW_SKILL), { recursive: true })
    await writeFile(join(skillRoot, NEW_SKILL, 'SKILL.md'), skillText(NEW_SKILL, '# a third party wrote this'))
    // The baseline check (P3) refuses it by name, before anything else runs.
    expect(await refusalOf(svc.checkProductionBaseline('cap1'))).toContain('skill-baseline-changed')
    // And the promotion gate refuses it in its own words, so an apply cannot
    // reach the commit either way.
    const message = await refusalOf(svc.apply('cap1', 'root-1', 'approval:apply'))
    expect(message).toContain('skill-name-taken')
    expect(registry[NEW_ROW]).toBeUndefined()
    expect(await readFile(join(skillRoot, NEW_SKILL, 'SKILL.md'), 'utf8')).toBe(skillText(NEW_SKILL, '# a third party wrote this'))
    expect((await ledgerLines(svc.root)).some(line => line.kind === 'commit_intent')).toBe(false)
  })

  it('leaves no usable half-product when the commit stops mid-write, and the explicit recovery settles it', async () => {
    let interrupted = false
    const f = await fixture({
      commitProbe: stage => {
        if (stage === 'write-renamed' && !interrupted) {
          interrupted = true
          throw new Error('fixture: interrupted after the first rename')
        }
      },
    })
    const { svc, skillRoot, registry } = f
    await capabilityDecided(f)
    const message = await refusalOf(svc.apply('cap1', 'root-1', 'approval:apply'))
    expect(message).toContain('fixture: interrupted after the first rename')
    // The registry never moved: no capability grants the half-written provider,
    // and no completion claims one.
    expect(registry[NEW_ROW]).toBeUndefined()
    const lines = await ledgerLines(f.root)
    expect(lines.some(line => line.kind === 'commit_intent')).toBe(true)
    expect(lines.some(line => line.kind === 'applied')).toBe(false)
    expect(await svc.openIntentTargets()).toEqual([
      join(skillRoot, NEW_SKILL, 'SKILL.md'),
      join(skillRoot, NEW_SKILL, SKILL_SIDECAR_FILE),
    ])

    // The explicit recovery entry settles it; production ends complete, the row
    // is in place, and nothing half-written survives.
    const outcomes = await svc.reconcile()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.result, outcomes[0]!.detail ?? '').toBe('completed-redone')
    expect(registry[NEW_ROW]).toEqual({ skills: [NEW_SKILL], tools: ['filesystem'] })
    expect(await readFile(join(skillRoot, NEW_SKILL, 'SKILL.md'), 'utf8')).toBe(CANDIDATE_TEXT)
    expect(await readFile(join(skillRoot, NEW_SKILL, SKILL_SIDECAR_FILE), 'utf8')).toBe(serializeSkillSidecar(executionSidecar(CANDIDATE_TEXT)))
    expect((await ledgerLines(f.root)).some(line => line.kind === 'applied')).toBe(true)
    expect(await svc.openIntentTargets()).toEqual([])
  })
})

describe('capability candidate: the table file is the commit\'s last durable step', () => {
  it('stops between the registry row and the table file, and only the reconciliation completes it', async () => {
    let stopped = false
    const f = await fixture({
      capabilityConfigProbe: (stage) => {
        if (stage === 'before-write' && !stopped) {
          stopped = true
          throw new Error('fixture: interrupted before the table file was written')
        }
      },
    })
    const { svc, root, registry, config } = f
    await capabilityDecided(f)
    const message = await refusalOf(svc.apply('cap1', 'root-1', 'approval:apply'))
    expect(message).toContain('fixture: interrupted before the table file was written')
    // Where the commit really stopped: the in-process registry already holds the
    // row (the mirror is written before the file), the table file does not, and no
    // completion was recorded. A restart reads the *file*, so the row is not yet
    // one the deployment keeps.
    expect(registry[NEW_ROW]).toEqual({ skills: [NEW_SKILL], tools: ['filesystem'] })
    const stoppedFile = await readFile(config.capabilityConfig!, 'utf8')
    expect(stoppedFile).not.toContain(`"${NEW_ROW}"`)
    const open = await ledgerLines(root)
    expect(open.some(line => line.kind === 'commit_intent')).toBe(true)
    expect(open.some(line => line.kind === 'applied')).toBe(false)
    expect(await svc.openIntentTargets()).toEqual([
      join(f.skillRoot, NEW_SKILL, 'SKILL.md'),
      join(f.skillRoot, NEW_SKILL, SKILL_SIDECAR_FILE),
    ])

    // A second service image over the same ledger root settles it: the row is
    // written into the table file, and only then is the completion recorded.
    const reopened = new EvolutionService(f.ctx, { ...config, capabilityConfigProbe: undefined })
    const outcomes = await reopened.reconcile()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.result, outcomes[0]!.detail ?? '').toContain('completed')
    const settled = await readFile(config.capabilityConfig!, 'utf8')
    expect(settled).toContain(`"${NEW_ROW}": {"skills":["${NEW_SKILL}"],"tools":["filesystem"]}`)
    expect(settled).toContain(`${STORE_ROW}: { skills: [${STORE_SKILL}], tools: [filesystem, bash] }`)
    expect((await ledgerLines(root)).filter(line => line.kind === 'applied')).toHaveLength(1)
    expect(await reopened.openIntentTargets()).toEqual([])
  })

  it('records the completion over a table file already written, without writing production a second time', async () => {
    let stopped = false
    const f = await fixture({
      capabilityConfigProbe: (stage) => {
        if (stage === 'written' && !stopped) {
          stopped = true
          throw new Error('fixture: interrupted after the table file was written')
        }
      },
    })
    const { svc, root, config } = f
    await capabilityDecided(f)
    const message = await refusalOf(svc.apply('cap1', 'root-1', 'approval:apply'))
    expect(message).toContain('fixture: interrupted after the table file was written')
    // The file holds the row and production holds the object; what the dead
    // process never wrote is the completion.
    const writtenFile = await readFile(config.capabilityConfig!, 'utf8')
    expect(writtenFile).toContain(`"${NEW_ROW}": {"skills":["${NEW_SKILL}"],"tools":["filesystem"]}`)
    expect(await readFile(join(f.skillRoot, NEW_SKILL, 'SKILL.md'), 'utf8')).toBe(CANDIDATE_TEXT)
    expect((await ledgerLines(root)).some(line => line.kind === 'applied')).toBe(false)

    const reopened = new EvolutionService(f.ctx, { ...config, capabilityConfigProbe: undefined })
    const outcomes = await reopened.reconcile()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.result).toBe('completed-written')
    // Exactly one completion, the same file bytes, and the same object on disk.
    expect((await ledgerLines(root)).filter(line => line.kind === 'applied')).toHaveLength(1)
    expect(await readFile(config.capabilityConfig!, 'utf8')).toBe(writtenFile)
    expect(await readFile(join(f.skillRoot, NEW_SKILL, 'SKILL.md'), 'utf8')).toBe(CANDIDATE_TEXT)
    expect(await reopened.openIntentTargets()).toEqual([])
  })
})
