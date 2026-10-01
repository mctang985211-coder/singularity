/**
 * A6 interface ②: the capability candidate's two-sided evaluation evidence and
 * the promotion gate that reads it (`EvolutionService.checkPromotion`, which
 * `decide(PROMOTE)` and `apply` call again on their own entries).
 *
 * The fixture records a complete capability experiment through the service's own
 * write path: the production configuration refuses the samples' row (so the
 * baseline side is `not-admitted`, with the runtime's refusal and the gap it
 * stands for — no Task, no Run, no invented failure), and the candidate side is a
 * run of the experiment's own lineage, verified by the frozen judge on the
 * overlay's own provider identity. What this file asserts is what the gate does
 * with that evidence, and what each kind of tampering, drift or unmet condition
 * produces instead — every refusal with nothing written.
 *
 * The *real* admission and execution are proven in
 * `tests/integration/capability-experiment.spec.ts`, which runs the same flow on
 * the real task store, runtime, spawn and verifier.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityConfig, SkillSidecar } from '@dangosys/dsh-singularity-task-runtime'
import { SKILL_SIDECAR_FILE, serializeSkillSidecar } from '@dangosys/dsh-singularity-task-runtime'
import { EvolutionService } from '../../src/evolution.ts'
import type { Config, GateAnswers, ProposeInput } from '../../src/evolution.ts'
import { modelSelectionOf } from '../../src/replay.ts'
import { recordCapabilityExperiment } from './fixtures/capability-experiment.ts'
import { writeCapabilityConfig } from '../../../tests/support/capability-config.ts'
import type { CapabilityExperimentStore, CapabilityExperimentOptions } from './fixtures/capability-experiment.ts'

const VERIFIER_VOCABULARY = ['command', 'composite', 'review']
const STORE_ROW = 'a6-store-row'
const STORE_SKILL = 'a6-existing-guidance'
const STORE_ENTRY: CapabilityConfig = { skills: [STORE_SKILL], tools: ['filesystem', 'bash'] }
const NEW_ROW = 'a6-capability'
const NEW_SKILL = 'a6-capability-skill'
const SELECTION = modelSelectionOf({ provider: 'p', model: 'm' })!

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function skillText(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: an A6 capability-gate fixture skill\n---\n\n${body}\n`
}

const CANDIDATE_TEXT = skillText(NEW_SKILL, '# the new execution skill')

function executionSidecar(content: string): SkillSidecar {
  return {
    contractVersion: 1,
    type: 'execution',
    capabilities: [NEW_ROW],
    precondition: 'the fixture gap is present',
    inputs: [],
    outputs: [],
    requiredTools: ['read', 'write'],
    verifier: { ref: 'command' },
    content: { skillMdSha256: sha256Hex(content), resources: [] },
  } as SkillSidecar
}

const proposal: ProposeInput = {
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

function mutation(): unknown {
  return {
    rows: { [NEW_ROW]: { skills: [NEW_SKILL], tools: ['filesystem'] } },
    skill: { name: NEW_SKILL, content: CANDIDATE_TEXT, sidecar: executionSidecar(CANDIDATE_TEXT) },
  }
}

interface Fixture {
  svc: EvolutionService
  root: string
  skillRoot: string
  registry: Record<string, CapabilityConfig>
  rows: CapabilityExperimentStore
  sourceTask?: Record<string, unknown>
  sessions: Map<string, SessionEvent[]>
  workspace: string
  experiment: Awaited<ReturnType<typeof recordCapabilityExperiment>>
}

/**
 * One prepared capability candidate on a fixture deployment: the ledger, the
 * production skill root, the store the evidence lives in, and the recorded
 * two-sided experiment. The trace runs propose → candidate → prepare → record
 * the experiment, and stops before the gate so each case can tamper first.
 */
async function fixture(
  options: {
    registry?: Record<string, CapabilityConfig>
    experiment?: CapabilityExperimentOptions
    sourceStatus?: 'failed' | 'verified'
    /** Runs after the experiment is recorded and before any gate: the case that changes one fact. */
    tamper?: (parts: Fixture) => Promise<void>
  } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'capability-gate-'))
  const root = join(dir, 'evolution')
  const skillRoot = join(dir, 'skills')
  const home = join(dir, 'home')
  const workspace = join(dir, 'snapshot')
  await mkdir(join(home, 'skills', STORE_SKILL), { recursive: true })
  await writeFile(
    join(home, 'skills', STORE_SKILL, 'SKILL.md'),
    skillText(STORE_SKILL, '# the guidance the store already grants'),
  )
  await mkdir(skillRoot, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'input.txt'), 'the frozen input\n')
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('HOME', home)
  const registry: Record<string, CapabilityConfig> = options.registry ?? { [STORE_ROW]: STORE_ENTRY }
  const rows: CapabilityExperimentStore = { tasks: [], runs: [], reviews: [], evidence: [] }
  const sessions = new Map<string, SessionEvent[]>()
  const ctx = {
    reflect: { provide: () => {} },
    effect: () => {},
    taskRuntime: {
      listCapabilities: () => structuredClone(registry),
      applyCapabilityRow: async (name: string, entry: CapabilityConfig | null) => {
        if (entry === null) delete registry[name]
        else registry[name] = structuredClone(entry)
      },
    },
    task: {
      openStore: async () => ({
        ...rows,
        diagnoses: options.sourceStatus
          ? [
              {
                diagnosisId: 'd1',
                taskId: 't-success',
                reviewRefs: ['t-success#r-success'],
                proposals: [{ targetType: 'capability', targetId: NEW_ROW, rationale: 'faster' }],
              },
            ]
          : [],
        obligations: [],
      }),
    },
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
    modelSelection: () => SELECTION,
    // The capability table's own file (A6): a promotion that commits a row writes
    // it here before the completion is recorded.
    capabilityConfig: await writeCapabilityConfig(join(dir, 'config.yml'), registry),
  }
  const svc = new EvolutionService(ctx, config)
  await svc.propose(proposal, 'root-1')
  await svc.candidate('cap1', VERSION_SET, 'root-1', mutation())
  await svc.prepare('cap1', 'root-1')
  const experiment = await recordCapabilityExperiment(
    svc,
    {
      root,
      skillRoot,
      registry,
      rows,
      sessions,
      workspace,
      selection: SELECTION,
    },
    await svc.get('cap1'),
    options.experiment ?? {},
  )
  let sourceTask: Record<string, unknown> | undefined
  if (options.sourceStatus) {
    sourceTask = { taskId: 't-success', objective: 'a source', status: options.sourceStatus, runIds: ['r-success'] }
    rows.tasks.push(sourceTask)
    rows.runs.push({ runId: 'r-success', taskId: 't-success', status: options.sourceStatus })
  }
  const parts: Fixture = { svc, root, skillRoot, registry, rows, sessions, workspace, experiment, sourceTask }
  // The tamper case runs between the evidence and the gate: everything the gate
  // reads is already recorded, and the case changes exactly one of those facts.
  if (options.tamper !== undefined) await options.tamper(parts)
  return parts
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
 * Every line one refused promotion must not have written, and the production it
 * must not have touched. `heldRow` is the row the registry already held before
 * the case (a replaced-row candidate): the refusal must leave it exactly as it
 * was.
 */
async function assertZeroWrites(f: Fixture, heldRow?: CapabilityConfig): Promise<void> {
  const lines = await ledgerLines(f.root)
  expect(lines.some(line => line.kind === 'decided')).toBe(false)
  expect(lines.some(line => line.kind === 'commit_intent')).toBe(false)
  expect(lines.some(line => line.kind === 'applied')).toBe(false)
  expect(f.registry[NEW_ROW]).toEqual(heldRow)
  expect(existsSync(join(f.skillRoot, NEW_SKILL))).toBe(false)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('capability promotion: the evidence the gate reads', () => {
  it('records the refused production baseline as not-admitted — no run, no champion — beside a candidate that really ran', async () => {
    const f = await fixture()
    // The evidence itself: what the refused baseline side is.
    const baselineRecords = (await ledgerLines(f.root)).filter(
      line => line.kind === 'experiment_sample' && line.side === 'baseline',
    )
    expect(baselineRecords).toHaveLength(2)
    for (const record of baselineRecords) {
      expect(record).toMatchObject({
        outcome: 'not-admitted',
        admission: {
          source: 'capability-gap',
          proposalId: 'cap1',
          sourceRefs: ['diagnosis:d1'],
          required: [NEW_ROW],
          missing: [NEW_ROW],
        },
      })
      expect(typeof (record.admission as Record<string, unknown>).reason).toBe('string')
      expect(String((record.admission as Record<string, unknown>).reason)).toContain('task-runtime:')
      // No Task, no Run, no Review, no evidence, no cost, no workspace digest.
      expect(record.taskId).toBeUndefined()
      expect(record.runId).toBeUndefined()
      expect(record.reviewRef).toBeUndefined()
      expect(record.evidenceRefs).toEqual([])
      expect(record.criteria).toEqual([])
      expect(record.initialDigest).toBeUndefined()
    }
    // The store holds no replay of the baseline side at all: the refusal is the
    // whole record, and no failure run stands in its place.
    expect(f.rows.tasks.some(task => String(task.objective).includes(':baseline] '))).toBe(false)

    // The candidate side is a real run of this experiment, and the report says
    // the failure the production configuration could not even admit is fixed.
    const report = f.experiment.report
    expect(report.verdict).toBe('fixed')
    expect(report.samples.map(sample => sample.verdict)).toEqual(['fixed', 'maintained'])
    expect(report.samples[0]!.baseline.outcome).toBe('not-admitted')
    expect(report.samples[0]!.candidate.outcome).toBe('verified')
    expect(report.samples[0]!.candidate.criteria.every(criterion => criterion.verdict === 'pass')).toBe(true)

    // Through the real entries: the gate passes, the human decides, the apply
    // writes the row and the object.
    const evidence = await f.svc.checkPromotion('cap1')
    expect(evidence.providers).toHaveLength(1)
    await f.svc.gate('cap1', gateAnswers([f.experiment.reportPath]), 'root-1')
    expect((await f.svc.decide('cap1', 'PROMOTE', 'root-1', 'approval:decide')).status).toBe('decided')
    await f.svc.apply('cap1', 'root-1', 'approval:apply')
    expect(f.registry[NEW_ROW]).toEqual({ skills: [NEW_SKILL], tools: ['filesystem'] })
    expect(await readFile(join(f.skillRoot, NEW_SKILL, SKILL_SIDECAR_FILE), 'utf8')).toBe(
      serializeSkillSidecar(executionSidecar(CANDIDATE_TEXT)),
    )
  })

  it('reads a baseline that really ran when production holds the row, and promotes only a clean fix', async () => {
    const previous: CapabilityConfig = { skills: ['a6-fixture-guidance'], tools: ['filesystem'] }
    const f = await fixture({
      registry: { [STORE_ROW]: STORE_ENTRY, [NEW_ROW]: previous },
      experiment: { baseline: 'reproduce' },
    })
    expect(f.experiment.report.samples.map(sample => sample.verdict)).toEqual(['fixed', 'maintained'])
    expect(f.experiment.report.samples[0]!.baseline.outcome).toBe('failed')
    expect(await refusalOf(f.svc.checkPromotion('cap1'))).toBe('')
    await f.svc.gate('cap1', gateAnswers([f.experiment.reportPath]), 'root-1')
    await f.svc.decide('cap1', 'PROMOTE', 'root-1', 'approval:decide')
    await f.svc.apply('cap1', 'root-1', 'approval:apply')
    expect(f.registry[NEW_ROW]).toEqual({ skills: [NEW_SKILL], tools: ['filesystem'] })
  })
})

describe('capability promotion: every missing piece is a named refusal with zero writes', () => {
  it('keeps a successful source suggestion but refuses promotion and application without a frozen comparator', async () => {
    const f = await fixture({ sourceStatus: 'verified' })
    expect((await f.svc.get('cap1')).sourceRefs).toEqual(['diagnosis:d1'])
    const promotion = await refusalOf(f.svc.checkPromotion('cap1'))
    expect(promotion).toMatch(/successful source.*frozen.*comparator/i)
    await f.svc.gate('cap1', gateAnswers([f.experiment.reportPath]), 'root-1')
    expect(await refusalOf(f.svc.decide('cap1', 'PROMOTE', 'root-1', 'approval:decide'))).toMatch(
      /successful source.*frozen.*comparator/i,
    )
    await assertZeroWrites(f)
  })

  it('rechecks a source that becomes verified after the decision and before apply writes production', async () => {
    const f = await fixture({ sourceStatus: 'failed' })
    await f.svc.gate('cap1', gateAnswers([f.experiment.reportPath]), 'root-1')
    await f.svc.decide('cap1', 'PROMOTE', 'root-1', 'approval:decide')
    f.sourceTask!.status = 'verified'
    expect(await refusalOf(f.svc.apply('cap1', 'root-1', 'approval:apply'))).toMatch(
      /successful source.*frozen.*comparator/i,
    )
    const lines = await ledgerLines(f.root)
    expect(lines.some(line => line.kind === 'commit_intent' || line.kind === 'applied')).toBe(false)
    expect(f.registry[NEW_ROW]).toBeUndefined()
    expect(existsSync(join(f.skillRoot, NEW_SKILL))).toBe(false)
  })

  it('refuses a gate with no experiment at all — the baseline preflight cannot be skipped', async () => {
    const f = await fixture()
    // A second proposal of its own, prepared but never evaluated: the shape a
    // caller that skipped evolution_replay reaches. The gate itself refuses,
    // because the six answers must rest on a completed experiment — and so does
    // the promotion preflight every promotion entry runs.
    await f.svc.propose({ ...proposal, proposalId: 'cap2', sourceRefs: ['diagnosis:d2'] }, 'root-1')
    await f.svc.candidate('cap2', VERSION_SET, 'root-1', mutation())
    await f.svc.prepare('cap2', 'root-1')
    const atGate = await refusalOf(f.svc.gate('cap2', gateAnswers([f.skillRoot]), 'root-1'))
    expect(atGate).toContain('has no two-sided experiment')
    const atPromotion = await refusalOf(f.svc.checkPromotion('cap2'))
    expect(atPromotion).toContain('carries no two-sided experiment')
    const atDecide = await refusalOf(f.svc.decide('cap2', 'PROMOTE', 'root-1', 'approval:decide'))
    expect(atDecide).toContain('is prepared')
    const lines = await ledgerLines(f.root)
    expect(lines.filter(line => line.kind === 'decided')).toHaveLength(0)
    expect(lines.filter(line => line.kind === 'gated')).toHaveLength(0)
    expect(lines.some(line => line.kind === 'commit_intent')).toBe(false)
    expect(f.registry[NEW_ROW]).toBeUndefined()
    expect(existsSync(join(f.skillRoot, NEW_SKILL))).toBe(false)
  })

  it('refuses a candidate side that was admitted but never executed a task', async () => {
    // The record claims a verified candidate while the store holds no run for
    // it: admission passing is not the fix the promotion reads.
    const f = await fixture({ experiment: { omitCandidateRuns: true } })
    const message = await refusalOf(f.svc.checkPromotion('cap1'))
    expect(message).toMatch(
      /does not cite a replayed task this experiment created|cites run .* which no run of this experiment/,
    )
    await assertZeroWrites(f)
  })

  it('refuses a verdict decided by a judge other than the frozen one', async () => {
    const f = await fixture({ experiment: { sideVerifierVersion: '2' } })
    const message = await refusalOf(f.svc.checkPromotion('cap1'))
    expect(message).toMatch(/judge|verifier/i)
    expect(message).toContain('command')
    await assertZeroWrites(f)
  })

  it('refuses a report edited after the experiment, even when every other fact still holds', async () => {
    const f = await fixture()
    const path = join(f.root, f.experiment.reportPath)
    // A schema-valid edit: the file still parses as a report, but its bytes are
    // no longer the bytes the ledger's records recompute to.
    const report = JSON.parse(await readFile(path, 'utf8')) as { at: string }
    report.at = '2026-09-27T00:00:00.000Z'
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
    const message = await refusalOf(f.svc.checkPromotion('cap1'))
    expect(message).toContain('is not the report its ledger records recompute to')
    await assertZeroWrites(f)
  })

  it('refuses evidence whose frozen candidate identity is not the prepared one', async () => {
    const f = await fixture({
      tamper: async parts => {
        // A newer experiment freezes another skill object for the same proposal:
        // the identity the evidence belongs to is not the candidate this
        // promotion would write.
        const proposalNow = await parts.svc.get('cap1')
        const other = {
          name: NEW_SKILL,
          sha256: 'b'.repeat(64),
          contract: { sha256: 'c'.repeat(64), contractDigest: 'd'.repeat(64) },
        }
        await recordCapabilityExperiment(
          parts.svc,
          {
            root: parts.root,
            skillRoot: parts.skillRoot,
            registry: parts.registry,
            rows: parts.rows,
            sessions: parts.sessions,
            workspace: parts.workspace,
            selection: SELECTION,
          },
          { ...proposalNow, prepared: { ...proposalNow.prepared!, skillContent: other } },
          {} as never,
        )
      },
    })
    const message = await refusalOf(f.svc.checkPromotion('cap1'))
    expect(message).toMatch(/capability-evidence-drifted|different candidate bytes/)
    await assertZeroWrites(f)
  })

  it('refuses a holdout the candidate degraded, naming the sample', async () => {
    const f = await fixture({ experiment: { candidateFailures: ['t-cap-holdout'] } })
    const message = await refusalOf(f.svc.checkPromotion('cap1'))
    expect(message).toContain('t-cap-holdout')
    expect(message).toMatch(/capability-candidate-not-verified|every frozen criterion must pass/)
    await assertZeroWrites(f)
  })

  it('refuses a degraded holdout beside a fixed target when the baseline really ran', async () => {
    const previous: CapabilityConfig = { skills: ['a6-fixture-guidance'], tools: ['filesystem'] }
    const f = await fixture({
      registry: { [STORE_ROW]: STORE_ENTRY, [NEW_ROW]: previous },
      experiment: { baseline: 'reproduce', candidateFailures: ['t-cap-holdout'] },
    })
    expect(f.experiment.report.verdict).toBe('fixed-with-regression')
    const message = await refusalOf(f.svc.checkPromotion('cap1'))
    expect(message).toMatch(/capability-candidate-not-verified|capability-not-fixed/)
    expect(message).toContain('t-cap-holdout')
    await assertZeroWrites(f, previous)
  })

  it('refuses a failed run standing in for the refusal the experiment froze', async () => {
    // The frozen block records the production configuration's refusal, and the
    // record claims a failed run of that side instead: a failure run invented in
    // a refused side's place is exactly what the gate must not read.
    const f = await fixture({ experiment: { admission: true, baseline: 'failed' } })
    const message = await refusalOf(f.svc.checkPromotion('cap1'))
    expect(message).toContain('capability-baseline-not-refused')
    expect(message).toContain('refusal')
    await assertZeroWrites(f)
  })

  it('cannot even record a refusal where the frozen block admits the baseline', async () => {
    const previous: CapabilityConfig = { skills: ['a6-fixture-guidance'], tools: ['filesystem'] }
    // The frozen block admits the sample (production holds the row); the record
    // claims the runtime refused it. The report's own schema refuses the pair
    // before any gate reads it, so that shape cannot exist in the ledger.
    await expect(
      fixture({
        registry: { [STORE_ROW]: STORE_ENTRY, [NEW_ROW]: previous },
        experiment: { baseline: 'not-admitted', admission: false },
      }),
    ).rejects.toThrow(/is not-admitted, but the frozen sample records no production refusal/)
  })

  it('refuses an admission refusal that disagrees with the frozen rows', async () => {
    const f = await fixture({ experiment: { refusal: { missing: ['a-row-nobody-required'] } } })
    const message = await refusalOf(f.svc.checkPromotion('cap1'))
    expect(message).toContain('disagree about what was refused')
    await assertZeroWrites(f)
  })

  it('refuses a candidate bound to another registry revision than the frozen overlay', async () => {
    const f = await fixture({ experiment: { bindingRevision: '9'.repeat(64) } })
    const message = await refusalOf(f.svc.checkPromotion('cap1'))
    expect(message).toContain('bound registry revision')
    await assertZeroWrites(f)
  })

  it('refuses a candidate side whose binding omits the new skill it is supposed to have loaded', async () => {
    const f = await fixture({ experiment: { dropBoundSkill: true } })
    const message = await refusalOf(f.svc.checkPromotion('cap1'))
    expect(message).toMatch(/bound no skill/)
    await assertZeroWrites(f)
  })
})
