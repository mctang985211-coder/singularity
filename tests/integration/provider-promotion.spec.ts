import { TASK_GUIDANCE } from '../../task-runtime/tests/support/skill-roots.ts'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { EvolutionService, modelSelectionOf } from '../../evolution/src/index.ts'
import { defineEvolutionApplyTool } from '../../agent-singularity/src/tools/evolution-apply.ts'
import { recordPromotionExperiment } from '../support/promotion-experiment.ts'
import { defineEvolutionDecideTool } from '../../agent-singularity/src/tools/evolution-decide.ts'
import { defineEvolutionPrepareTool } from '../../agent-singularity/src/tools/evolution-prepare.ts'
import type { TaskEvent } from '../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../task/src/index.ts'
import type { CapabilityConfig, Config, DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'
import { personRequest } from '../../task-runtime/tests/support/person-request.ts'

/**
 * S1-C item 3 end to end: one illegal provider, four consumers, the same defect
 * code — and one legal provider that passes all four.
 *
 * The point of this file is the *consistency* the plan asks for. Admission, the
 * config load, a capability replacement and a candidate promotion all reach
 * their verdict through `validateSkillProvider`; a test that only checked one of
 * them could not tell "the validator refuses this" from "this one entry happens
 * to refuse it". So the same directory content is installed where each consumer
 * looks and every consumer is asked the same question:
 *
 * 1. **admission** (`decomposeAndRun`, the hard gate) — the worker's viewpoint:
 *    the fixture is installed under the checkout's own `.agents/skills`.
 * 2. **config load** (`providerLoadReport`, S1-C item 3) — the harness process's
 *    own viewpoint: the fixture is installed under a pinned `$DSH_HOME/skills`.
 * 3. **capability replacement** (`TaskRuntime.applyCapabilityRow`) — the row's
 *    providers, discovered from the harness process's own roots, judged before
 *    the row becomes effective in the running table.
 * 4. **the evolution lifecycle** — the production object the same-name candidate
 *    replaces, and the candidate object derived from it: `checkPromotion` where
 *    the shape can be frozen and re-derived, `evolution_prepare` where the loader
 *    refuses it before a candidate can exist (K3).
 *
 * The evolution *capability* promotion entry is no longer one of them: S4-E
 * §F.2/EVAL-4 refuses a PROMOTE without an evaluator, so the row check's live
 * consumer is the runtime registry mirror (the same one the rollback tool calls).
 * That refusal is asserted beside the four, so the property "one illegal provider,
 * one defect code" still holds for every entry that judges the row today.
 *
 * What is real: the task store and reducer, the runtime's admission and
 * pre-check, the sidecar loader/validator, the capability table, the verifier
 * registry with its built-ins, the evolution ledger and its promotion entries.
 * What is stubbed, and why: `sessionPersistence` (in-memory), `spawn` (no model
 * loop), `agents`, `graphs`/`envBuilder` (a fixed checkout inside this test's
 * tmp dir), `tools`/`approval` (the plugin seams the evolution tools ask
 * through). No refusal is read from a return value the writer controls: config
 * bytes, the ledger and the production root are read back from disk.
 */

const ROOT_SESSION = 'root-1'
const STORE = rootTaskStoreId(ROOT_SESSION)
const ROW = 'promotion-fixture-capability'
const SKILL = 'promotion-fixture-skill'

const TABLE: Readonly<Record<string, CapabilityConfig>> = {
  [ROW]: { skills: [SKILL], tools: ['filesystem', 'bash'] },
}

/** A capability row with no shell: the covering set for the tool-gap shape. */
const NARROW_TABLE: Readonly<Record<string, CapabilityConfig>> = {
  [ROW]: { skills: [SKILL], tools: ['filesystem'] },
}

const CONFIG_FIXTURE = [
  '- id: task-runtime',
  '  config:',
  '    capabilities:',
  '      research: { preset: standard }',
  '',
  '---',
  'api:',
  '  upstream: https://example.invalid',
  '',
].join('\n')

interface Harness {
  runtime: TaskRuntime
  evolution: EvolutionService
  task: TaskService
  /** The tools the agent plugin registered; the evolution tools are driven through them. */
  tools: Map<string, { execute(args: Record<string, unknown>, exec?: unknown): unknown }>
  approval: { request: ReturnType<typeof vi.fn> }
  configFile: string
  skillRoot: string
  home: string
  checkout: string
  taskEvents(): TaskEvent[]
}

const contexts: Context[] = []
let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'provider-promotion-'))
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  await rm(workspace, { recursive: true, force: true })
})

/** SHA-256 of text, computed here so the implementation is never confirmed against itself. */
function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** A loadable `SKILL.md`: the frontmatter `readSkillFile` requires, plus whatever body a test is about. */
function skillText(body: string, name = SKILL): string {
  return `---\nname: ${name}\ndescription: fixture skill for the provider-check consistency test\n---\n\n${body}`
}

interface SkillShape {
  sidecar?: 'execution' | 'knowledge'
  verifierRef?: string
  capabilities?: readonly string[]
  requiredTools?: readonly string[]
  /** Files the directory holds at supported resource positions. */
  resources?: Readonly<Record<string, string>>
  /**
   * Resource paths whose declaration is a digest of something *else* than the
   * bytes written: the identity/bytes disagreement the loader must refuse, with
   * no other defect to hide behind.
   */
  mismatched?: readonly string[]
}

/**
 * Write one skill directory as every provider check reads it: a `SKILL.md` whose
 * frontmatter declares the granted name, plus — when the shape asks for one — a
 * sidecar whose declared content identity is the digest of exactly those bytes.
 * `mismatched` names resources the declaration covers with a digest that is not
 * their content, which is the one shape only a filesystem read can catch.
 */
async function writeSkillDirectory(directory: string, name: string, content: string, shape: SkillShape = {}): Promise<string> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), content)
  const resources = Object.entries(shape.resources ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  for (const [path, contents] of resources) {
    await mkdir(dirname(join(directory, path)), { recursive: true })
    await writeFile(join(directory, path), contents)
  }
  if (shape.sidecar === undefined) return directory
  const identity = {
    skillMdSha256: sha256Of(content),
    resources: resources.map(([path, contents]) => ({
      path,
      sha256: (shape.mismatched ?? []).includes(path) ? '0'.repeat(64) : sha256Of(contents),
    })),
  }
  const declared = shape.sidecar === 'execution'
    ? {
        contractVersion: 1,
        type: 'execution',
        capabilities: [...(shape.capabilities ?? [])],
        precondition: 'the fixture skill is installed where discovery looks',
        inputs: [],
        outputs: [],
        requiredTools: [...(shape.requiredTools ?? [])],
        verifier: { ref: shape.verifierRef },
        content: identity,
      }
    : {
        contractVersion: 1,
        type: 'knowledge',
        source: 'this test fixture',
        scope: 'provider-check consistency only',
        content: identity,
        contentCheck: { kind: 'command', command: 'true' },
      }
  await writeFile(join(directory, 'SKILL.contract.json'), `${JSON.stringify(declared, null, 2)}\n`)
  return directory
}

async function harness(options: { capabilities?: Readonly<Record<string, CapabilityConfig>> } = {}): Promise<Harness> {
  const home = join(workspace, 'home')
  const checkout = join(workspace, 'env')
  await mkdir(join(home, 'skills'), { recursive: true })
  await mkdir(checkout, { recursive: true })
  // Both roots the discovery reaches beyond a checkout are pinned inside this
  // test's fixture — `$DSH_HOME/skills` and the user root `~/.agents/skills` —
  // and every fixture skill is named something no deployment installs, so the
  // machine running the suite cannot decide a verdict here.
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('HOME', home)

  const ctx = new Context()
  contexts.push(ctx)
  const log = new Map<string, SessionEvent[]>()
  const headers = new Map<string, SessionHeader>()
  // The person's request, on the root session's own durable log: what a root
  // contract's origin is read from (A0 §1.10). The rule is the *existence* of a
  // user-sourced message, so one text stands for the request this harness intakes on.
  log.set(ROOT_SESSION, [personRequest('ship the release')])
  ctx.provide('sessionPersistence', {
    list: async () => [...headers.values()].map(header => ({ header })),
    create: async (header: SessionHeader) => {
      headers.set(header.id, header)
      log.set(header.id, [])
      return {
        read: async () => ({ events: log.get(header.id) ?? [] }),
        append: async (records: readonly SessionEvent[]) => { log.get(header.id)?.push(...records) },
        flush: async () => {},
        close: async () => {},
      }
    },
    open: async (id: SessionId) => {
      const stored = log.get(id)
      if (stored === undefined) throw new Error(`missing session ${id}`)
      return {
        read: async () => ({ events: stored }),
        append: async (records: readonly SessionEvent[]) => { stored.push(...records) },
        flush: async () => {},
        close: async () => {},
      }
    },
  } as never)
  // The session plane's own read (`sessionQuery.readSession`): the model half of
  // the promotion gate re-reads each side's requests through it (S4-E §Q3), so
  // the harness serves the same in-memory log its persistence writes.
  ctx.provide('sessionQuery', {
    readSession: async (id: SessionId) => {
      const events = log.get(id)
      if (events === undefined) throw new Error(`missing session ${id}`)
      return { session: { id }, inheritedEventCount: 0, events }
    },
  } as never)
  ctx.provide('agentRuntime', {
    spawn: async (_parent: unknown, request: { sessionId: string }) => ({
      agent: {
        id: request.sessionId,
        cancel: () => {},
          // A live worker hands its result in before it goes idle (A3 §3.2): an
          // idle session is not a completion, so a stub that only went idle would
          // be stopped by the no-progress rule instead of being verified.
        whenIdle: async () => { await runtime.submitResult(request.sessionId, { summary: 'worker finished (fixture auto-submit)' }) },
      },
      dispose: async () => {},
    }),
  } as never)
  ctx.provide('agents', { get: (sessionId: string) => ({ id: sessionId }) } as never)
  ctx.provide('graphs', { graphForSession: async () => ({ id: 'g1', envId: 'env1', rootSessionId: ROOT_SESSION }) } as never)
  ctx.provide('envBuilder', { store: { get: () => ({ path: checkout }) } } as never)

  const tools = new Map<string, { execute(args: Record<string, unknown>, exec?: unknown): unknown }>()
  const approval = { request: vi.fn(async () => 'allowed-once') }
  const task = new TaskService(ctx)
  const verifier = new VerifierRegistry(ctx, { evidenceRoot: join(workspace, 'evidence') })
  // Cordis readies the plugin's registry on load; a hand-built one must be
  // readied explicitly, or `verifierIds()` reports no vocabulary and every
  // execution provider would be refused for the wrong reason.
  await verifier.ready()
  const runtime = new TaskRuntime(ctx, {
    capabilities: { ...TASK_GUIDANCE, ...(options.capabilities ?? TABLE) },
    runBindingRoot: join(workspace, 'run-bindings'),
  } as Config)
  const evolution = new EvolutionService(ctx, {
    root: join(workspace, 'evolution'),
    skillRoot: join(workspace, 'production-skills'),
    // The deployment's model selection: the experiment freezes it, the promotion
    // gate re-reads the runs' own requests against it (S4-E §F.2/§Q3).
    modelSelection: () => modelSelectionOf({ provider: 'p', model: 'm' })!,
  })
  await writeFile(join(workspace, 'config.yml'), CONFIG_FIXTURE)
  ctx.provide('tools', {
    register: (tool: { name: string; execute: (args: Record<string, unknown>, exec?: unknown) => unknown }) => {
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    },
  } as never)
  ctx.provide('userQuestions', { ask: async () => ({ answers: [] }) } as never)
  ctx.provide('approval', approval as never)

  const taskEvents = (): TaskEvent[] =>
    [...log.values()].flatMap(events => events.flatMap(event => (event.type === 'task/event' ? [event.data as unknown as TaskEvent] : [])))

  return {
    ctx,
    workspace,
    runtime,
    evolution,
    task,
    tools,
    approval,
    configFile: join(workspace, 'config.yml'),
    skillRoot: join(workspace, 'production-skills'),
    home,
    checkout,
    taskEvents,
  }
}

/**
 * The root task plus the run every entry resolves the caller through — activated
 * through the real intake (A0 §1.2) with this spec's own contract, stated here
 * rather than defaulted.
 */
function rootContract(objective: string): RootContractSpec {
  return { requiredCapabilities: ['execute-task'],
    objective,
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
  }
}

async function createRoot(h: Harness): Promise<{ storeId: string; taskId: string; runId: string }> {
  const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('ship the release'))
  if (activated.status !== 'activated') throw new Error(`the root contract was not activated: ${activated.detail}`)
  return { storeId: STORE, taskId: activated.taskId, runId: activated.runId }
}

/** The refused admission the runtime answered with; an admitted batch is this test's own failure. */
async function admissionRefusal(h: Harness, capability: string): Promise<string> {
  const root = await createRoot(h)
  try {
    const { batchId } = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT_SESSION, {
      reason: 'the ball needs verifying',
      children: [{
        objective: 'verify the ball',
        acceptanceCriteria: [{ description: 'verified', command: 'true' }],
        requiredCapabilities: [capability],
      }] as DecomposeSpec['children'],
    })
    await h.runtime.awaitBatch(root.storeId, batchId)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('the runtime admitted a batch naming an unusable provider')
}

/** Walk one skill candidate named `name` whose sandbox holds `content` to `gated`, ready for its promotion checks. */
async function skillCandidateGated(h: Harness, content: string, proposalId = 's1', name = SKILL): Promise<void> {
  const svc = h.evolution
  // The candidate must be a *replacement*: give the fixture a production SKILL.md
  // once, and never overwrite whatever a previous promotion put there.
  const production = join(h.skillRoot, name, 'SKILL.md')
  if (!existsSync(production)) {
    await mkdir(join(h.skillRoot, name), { recursive: true })
    await writeFile(production, skillText('# the production version', name), 'utf8')
  }
  await svc.propose({
    proposalId,
    targetType: 'skill',
    targetId: name,
    baseVersion: 'v1',
    level: 'L2',
    rationale: 'the skill never mentions empty-input fixtures',
    sourceRefs: ['diagnosis:d1'],
  }, ROOT_SESSION)
  await svc.candidate(proposalId, { skill: 'v2' }, ROOT_SESSION, { name, content })
  await svc.prepare(proposalId, ROOT_SESSION)
  // S4-E §F.2: the evidence a promotion reads is the completed two-sided
  // experiment, recorded through the ledger's own write entries.
  const { reportPath } = await recordPromotionExperiment(promotionExperimentContextFor(h), svc, { proposalId, selection: modelSelectionOf({ provider: 'p', model: 'm' })! })
  await svc.gate(proposalId, gateAnswers([reportPath]), ROOT_SESSION)
}

/**
 * The evolution lifecycle's own answer for one illegal provider, installed as the
 * production skill a same-name candidate replaces (K3): propose, candidate,
 * prepare — and then the promotion check, which judges the candidate object the
 * prepare derived from those bytes. Returns the first refusal's message, so the
 * caller compares it with the other three entries' codes; a lifecycle that
 * admitted the provider is this helper's own failure.
 */
async function lifecycleRefusal(
  h: Harness,
  content: string,
  shape: (typeof ILLEGAL_SHAPES)[number],
): Promise<{ entry: 'prepare' | 'promotion'; message: string }> {
  const declaredName = 'declaredName' in shape ? shape.declaredName : SKILL
  await writeSkillDirectory(join(h.skillRoot, SKILL), SKILL, content, shape.shape)
  const svc = h.evolution
  await svc.propose({
    proposalId: 's1',
    targetType: 'skill',
    targetId: SKILL,
    baseVersion: 'v1',
    level: 'L2',
    rationale: 'the fixture skill should carry newer wording',
    sourceRefs: ['diagnosis:d1'],
  }, ROOT_SESSION)
  await svc.candidate('s1', { skill: 'v2' }, ROOT_SESSION, { name: SKILL, content: skillText('# the illegal provider, improved', declaredName) })
  try {
    await svc.prepare('s1', ROOT_SESSION)
  } catch (error) {
    return { entry: 'prepare', message: error instanceof Error ? error.message : String(error) }
  }
  // The object was frozen: walk the candidate to the state whose PROMOTE judges it,
  // over a recorded experiment, so the refusal compared below is the promotion
  // check's — the same entry a human's decision goes through.
  const { reportPath } = await recordPromotionExperiment(promotionExperimentContextFor(h), svc, {
    proposalId: 's1',
    selection: modelSelectionOf({ provider: 'p', model: 'm' })!,
  })
  await svc.gate('s1', gateAnswers([reportPath]), ROOT_SESSION)
  try {
    await svc.checkPromotion('s1')
  } catch (error) {
    return { entry: 'promotion', message: error instanceof Error ? error.message : String(error) }
  }
  throw new Error(`the lifecycle admitted a provider with the defect "${shape.defect}"`)
}

/**
 * The store and scratch directory this hand-built harness offers the experiment
 * fixture: its own store, minted by the fixture, so the samples it cites are
 * never written into the store the runtime is admitting runs in.
 */
function promotionExperimentContextFor(h: Harness) {
  return {
    ctx: h.ctx,
    task: h.task as never,
    scratch: h.workspace,
    cwd: h.checkout,
    storeId: 'sg-t-promotion-fixture',
  }
}


function gateAnswers(refs: string[]) {
  return {
    targetFailureFixed: 'the fixture now passes',
    originalAcceptanceMaintained: 'original criteria unchanged and green',
    existingRegressionMaintained: 'full suite replayed green',
    noUnacceptableSideEffects: 'one row changes',
    holdoutPerformanceAcceptable: 'held-out fixtures pass',
    resourceCostAcceptable: 'same runtime as baseline',
    regressionEvidenceRefs: refs,
  }
}

function exec(sessionId: string) {
  return { agent: { id: sessionId }, callId: 'call-1', signal: new AbortController().signal } as never
}

/**
 * The five illegal shapes, each with the defect code every consumer must name:
 * an execution sidecar naming a verifier nobody registered, one requiring a tool
 * the row that grants it does not grant, one whose `SKILL.md` declares another
 * name, one whose declared resource identity is not the bytes on disk, and one
 * whose declaration is not a shape the contract reads.
 *
 * One directory name throughout (`SKILL`), for the row *and* for the skill the
 * candidate replaces: all four consumers then judge the same bytes under the same
 * name, so the defect they report cannot come from four different inputs.
 */
const ILLEGAL_SHAPES = [
  {
    label: 'an execution provider whose verifier is not registered',
    defect: 'verifier-unknown',
    row: TABLE,
    shape: { sidecar: 'execution', verifierRef: 'ghost-verifier', capabilities: [ROW], requiredTools: ['bash'] } as SkillShape,
  },
  {
    label: 'an execution provider whose required tools its capability does not grant',
    defect: 'tool-not-covered',
    row: NARROW_TABLE,
    shape: { sidecar: 'execution', verifierRef: 'command', capabilities: [ROW], requiredTools: ['bash'] } as SkillShape,
  },
  {
    label: 'a provider whose SKILL.md declares another name',
    defect: 'skill-name-mismatch',
    row: TABLE,
    shape: { sidecar: 'execution', verifierRef: 'command', capabilities: [ROW], requiredTools: ['bash'] } as SkillShape,
    declaredName: 's1c-other-skill-name',
  },
  {
    label: 'a provider whose declared resource identity is not the bytes on disk',
    defect: 'content-mismatch',
    row: TABLE,
    shape: {
      sidecar: 'execution',
      verifierRef: 'command',
      capabilities: [ROW],
      requiredTools: ['bash'],
      resources: { 'references/notes.md': 'the bytes that stand there\n' },
      mismatched: ['references/notes.md'],
    } as SkillShape,
  },
  {
    label: 'a provider whose declaration is not a shape the contract reads',
    defect: 'sidecar-shape',
    row: TABLE,
    shape: { sidecar: 'execution', verifierRef: 'command', capabilities: [], requiredTools: [] } as SkillShape,
  },
] as const

describe('one illegal provider, one defect code, every entry that still judges it (S1-C item 3)', () => {
  it.each(ILLEGAL_SHAPES)('$label: admission, config load, the registry mirror and the candidate promotion all name $defect', async shape => {
    const h = await harness({ capabilities: shape.row })
    const content = skillText('# the illegal provider', 'declaredName' in shape ? shape.declaredName : SKILL)
    // The same bytes, installed where each consumer looks.
    await writeSkillDirectory(join(h.checkout, '.agents', 'skills', SKILL), SKILL, content, shape.shape)
    await writeSkillDirectory(join(h.home, 'skills', SKILL), SKILL, content, shape.shape)

    // 1. Admission: the worker's own viewpoint, refusing the whole batch.
    const admission = await admissionRefusal(h, ROW)
    expect(admission).toContain('provider pre-check rejected decomposition')
    expect(admission).toContain(`${shape.defect}:`)

    // 2. The config load: the harness process's own viewpoint, reported loudly and
    //    not enforced — the same refusal, the same code.
    const load = await h.runtime.providerLoadReport()
    expect(load.failed).toBeUndefined()
    expect(load.defects).toHaveLength(1)
    expect(load.defects[0]).toContain(`capability "${ROW}" skill "${SKILL}"`)
    expect(load.defects[0]).toContain(`${shape.defect}:`)

    // 3. A capability replacement: the row's own provider, judged before the row
    //    becomes effective. S4-E took this consumer away from the evolution
    //    promotion entry (a capability proposal cannot even become a candidate in
    //    this build), so the row check is exercised where it still has a live
    //    consumer — the runtime registry mirror the rollback tool also calls.
    let capabilityRefusal = ''
    try {
      await h.runtime.applyCapabilityRow(ROW, { skills: [SKILL], tools: [...(shape.row[ROW]!.tools ?? [])] })
    } catch (error) {
      capabilityRefusal = error instanceof Error ? error.message : String(error)
    }
    expect(capabilityRefusal).toContain(`capability "${ROW}"`)
    expect(capabilityRefusal).toContain(`${shape.defect}:`)

    // 4. The evolution lifecycle, over the same bytes installed as the production
    //    skill the candidate replaces (K3). A same-name improvement freezes that
    //    object and re-derives the candidate's sidecar from it, so the provider the
    //    promotion judges *is* the bytes installed here — and the entry that judges
    //    them names the same code: the promotion check for a shape the lifecycle
    //    can freeze and re-derive, and `evolution_prepare` for the two shapes the
    //    loader refuses outright (a provider with unsupported resources, and a
    //    declaration the contract does not read), which therefore never become a
    //    candidate at all.
    const promotion = await lifecycleRefusal(h, content, shape)
    expect(promotion.message).toContain(`${shape.defect}:`)

    // Four entries, one code — the property a per-entry check could not prove.
    expect([admission, load.defects[0]!, capabilityRefusal, promotion.message].every(entry => entry.includes(`${shape.defect}:`))).toBe(true)

    // The same refusal through the tool a human decision goes through. A candidate
    // the lifecycle could freeze is refused by `evolution_decide`, which runs the
    // promotion check *before* it asks for approval — so a proposal that cannot be
    // promoted never burns a sign-off. A shape the loader refuses never reaches
    // that state, and the tool that judges it is `evolution_prepare` itself; both
    // are driven here the way the loop dispatches them, and neither may ask.
    const toolCtx = { evolution: h.evolution, approval: h.approval, taskRuntime: h.runtime } as never
    const toolRefusal = promotion.entry === 'prepare'
      ? (await defineEvolutionPrepareTool(toolCtx).execute({ proposalId: 's1' }, exec(ROOT_SESSION))) as string
      : (await defineEvolutionDecideTool(toolCtx).execute({ proposalId: 's1', decision: 'PROMOTE' }, exec(ROOT_SESSION))) as string
    expect(toolRefusal).toContain('rejected:')
    expect(toolRefusal).toContain(`${shape.defect}:`)
    expect(h.approval.request).not.toHaveBeenCalled()

    // None of the refusals had a side effect: no row written, no applied record,
    // no decision recorded, nothing spawned for the refused batch — and the
    // production directory still holds exactly the bytes this case installed,
    // byte for byte.
    expect(await readFile(h.configFile, 'utf8')).toBe(CONFIG_FIXTURE)
    expect(await readFile(join(h.skillRoot, SKILL, 'SKILL.md'), 'utf8')).toBe(content)
    const ledger = (await readFile(join(h.evolution.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
      .map(line => (JSON.parse(line) as { kind: string }).kind)
    expect(ledger).not.toContain('applied')
    expect(ledger).not.toContain('decided')
    expect(h.taskEvents().filter(event => event.kind === 'CapabilityGapDetected')).toEqual([])
  })

  it('admits, loads, mirrors and promotes one legal provider through every entry that still judges it', async () => {
    const h = await harness()
    const content = skillText('# a usable execution provider')
    const shape: SkillShape = { sidecar: 'execution', verifierRef: 'command', capabilities: [ROW], requiredTools: ['bash'] }
    await writeSkillDirectory(join(h.checkout, '.agents', 'skills', SKILL), SKILL, content, shape)
    await writeSkillDirectory(join(h.home, 'skills', SKILL), SKILL, content, shape)
    // 1. Admission admits the batch: the provider is discoverable, its verifier is
    //    registered and its required tools are granted by the row that carries it.
    const root = await createRoot(h)
    const batch = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT_SESSION, {
      reason: 'the ball needs verifying',
      children: [{
        objective: 'verify the ball',
        acceptanceCriteria: [{ description: 'verified', command: 'true' }],
        requiredCapabilities: [ROW],
      }] as DecomposeSpec['children'],
    })
    const outcomes = await h.runtime.awaitBatch(root.storeId, batch.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    // 2. The config load reports no defect at all for the same table.
    const load = await h.runtime.providerLoadReport()
    expect(load.defects).toEqual([])
    expect(load.failed).toBeUndefined()

    // 3. A capability row's own provider is admitted where it still becomes
    //    effective — the runtime registry mirror, which runs the same admission
    //    pre-check over the replacement. (A6 added the evolution side of that
    //    same check: a capability *candidate* is judged by it in
    //    `evolution/tests/unit/capability-candidate.spec.ts`, through the real
    //    pre-check this entry shares.)
    await h.runtime.applyCapabilityRow(ROW, { skills: [SKILL], tools: ['filesystem', 'bash'] })
    expect(h.runtime.listCapabilities()[ROW]).toEqual({ skills: [SKILL], tools: ['filesystem', 'bash'] })

    // 4. A skill candidate — the one target type this build evaluates and
    //    promotes — walks the promotion entries through the tools, and the human
    //    who reviews it sees the role the validator counted it as. A candidate
    //    carrying a sidecar or resources is refused here instead (the executor
    //    writes one file, so such a candidate is never reported as the execution
    //    provider it declares itself to be).
    const candidate = skillText('# the candidate the executor can carry', 'verify')
    await skillCandidateGated(h, candidate, 's2', 'verify')
    const toolCtx = { evolution: h.evolution, approval: h.approval, taskRuntime: h.runtime } as never
    const decided = (await defineEvolutionDecideTool(toolCtx).execute({ proposalId: 's2', decision: 'PROMOTE' }, exec(ROOT_SESSION))) as string
    expect(decided).toContain('[decided] PROMOTE')

    const appliedViaTool = (await defineEvolutionApplyTool(toolCtx).execute({ proposalId: 's2' }, exec(ROOT_SESSION))) as string
    expect(appliedViaTool).toContain('provider: skill `verify` → guidance')
    const applyReason = (h.approval.request.mock.calls.at(-1)![0] as { reason: string }).reason
    expect(applyReason).toContain('provider: skill `verify` → guidance (no sidecar; loadable guidance, not an execution provider)')
    expect(await readFile(join(h.skillRoot, 'verify', 'SKILL.md'))).toEqual(Buffer.from(candidate, 'utf8'))

    // The same candidate with a declaration added to its sandbox is refused at
    // the promotion entry — the executor writes one file, so the entry names the
    // boundary instead of reporting a provider production would never receive —
    // and the human is never asked about it.
    const withSidecar = skillText('# a candidate the executor cannot carry', 'verify')
    await skillCandidateGated(h, withSidecar, 's3', 'verify')
    await writeSkillDirectory(join(h.evolution.root, 'sandbox', 's3', 'skills', 'verify'), 'verify', withSidecar, {
      sidecar: 'execution',
      verifierRef: 'command',
      capabilities: [ROW],
      requiredTools: ['bash'],
    })
    const approvalsBefore = h.approval.request.mock.calls.length
    const refusedDecide = (await defineEvolutionDecideTool(toolCtx).execute({ proposalId: 's3', decision: 'PROMOTE' }, exec(ROOT_SESSION))) as string
    expect(refusedDecide).toContain('evolution_decide rejected:')
    // The candidate's sandbox holds a file the frozen identity does not name: the
    // shape boundary answers, because the executor promotes the fixed file set of
    // one guidance object and the sidecar is not part of the object prepare froze.
    expect(refusedDecide).toContain('exists in the sandbox, but the content identity recorded at prepare is guidance')
    expect(h.approval.request.mock.calls.length).toBe(approvalsBefore)
    expect((await h.evolution.get('s3')).status).toBe('gated')
    // production still holds exactly what was promoted, and nothing else.
    expect(await readFile(join(h.skillRoot, 'verify', 'SKILL.md'))).toEqual(Buffer.from(candidate, 'utf8'))
  })
})
