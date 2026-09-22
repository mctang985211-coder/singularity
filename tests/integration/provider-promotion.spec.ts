import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { EvolutionService } from '../../agent-singularity/src/evolution.ts'
import { defineEvolutionApplyTool } from '../../agent-singularity/src/tools/evolution-apply.ts'
import { defineEvolutionDecideTool } from '../../agent-singularity/src/tools/evolution-decide.ts'
import type { TaskEvent } from '../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../task/src/index.ts'
import type { CapabilityConfig, Config, DecomposeSpec } from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'

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
 * 3. **capability replacement** (`EvolutionService.checkPromotion` on a
 *    capability candidate) — the row's providers, discovered from the harness
 *    process's own roots.
 * 4. **candidate promotion** (`checkPromotion` on a skill candidate) — the
 *    candidate's own sandbox directory.
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
  ctx.provide('agentRuntime', {
    spawn: async () => ({ agent: { id: 'worker', cancel: () => {}, whenIdle: async () => {} }, dispose: async () => {} }),
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
    capabilities: { ...(options.capabilities ?? TABLE) },
    runBindingRoot: join(workspace, 'run-bindings'),
  } as Config)
  const evolution = new EvolutionService(ctx, {
    root: join(workspace, 'evolution'),
    skillRoot: join(workspace, 'production-skills'),
    presetRoot: join(workspace, 'production-presets'),
    configFile: join(workspace, 'config.yml'),
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

/** The root task plus the run every entry resolves the caller through. */
async function createRoot(h: Harness): Promise<{ storeId: string; taskId: string; runId: string }> {
  const { taskId, runId } = await h.runtime.createRootTask(STORE, { objective: 'ship the release', rootSessionId: ROOT_SESSION }, ROOT_SESSION)
  return { storeId: STORE, taskId, runId }
}

/** The refused admission the runtime answered with; an admitted batch is this test's own failure. */
async function admissionRefusal(h: Harness, capability: string): Promise<string> {
  const root = await createRoot(h)
  try {
    await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT_SESSION, {
      reason: 'the ball needs verifying',
      children: [{
        objective: 'verify the ball',
        acceptanceCriteria: [{ description: 'verified', command: 'true' }],
        requiredCapabilities: [capability],
      }] as DecomposeSpec['children'],
    })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('the runtime admitted a batch naming an unusable provider')
}

/** Walk one capability candidate carrying `entry` to `gated`, ready for its promotion checks. */
async function capabilityCandidateGated(h: Harness, entry: CapabilityConfig, proposalId = 'c1'): Promise<void> {
  const svc = h.evolution
  await svc.propose({
    proposalId,
    targetType: 'capability',
    targetId: ROW,
    baseVersion: 'v1',
    level: 'L2',
    rationale: 'the row should grant the verified provider',
    sourceRefs: ['diagnosis:d1'],
  }, ROOT_SESSION)
  await svc.candidate(proposalId, { capabilityTable: 'config.yml#doc1' }, ROOT_SESSION, { name: ROW, entry })
  await svc.prepare(proposalId, ROOT_SESSION, { capabilityEntry: h.runtime.listCapabilities()[ROW] ?? null })
  await svc.replay(proposalId, ROOT_SESSION, replayReport(proposalId, 'capability'))
  await svc.gate(proposalId, gateAnswers([`sandbox/${proposalId}/replay-report.json`]), ROOT_SESSION)
}

/** Walk one skill candidate named `name` whose sandbox holds `content` to `gated`, ready for its promotion checks. */
async function skillCandidateGated(h: Harness, content: string, proposalId = 's1', name = SKILL): Promise<void> {
  const svc = h.evolution
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
  const identity = (await svc.get(proposalId)).prepared!.skillContent!
  await svc.replay(proposalId, ROOT_SESSION, replayReport(proposalId, 'skill', identity))
  await svc.gate(proposalId, gateAnswers([`sandbox/${proposalId}/replay-report.json`]), ROOT_SESSION)
}

/** The one executed-report shape the replay entry accepts; this file is about the promotion entries, not about running the replay. */
function replayReport(proposalId: string, targetType: 'capability' | 'skill', candidateContent?: { name: string; sha256: string }): unknown {
  const side = (taskId: string) => ({ taskId, runId: `r-${taskId}`, outcome: 'verified', criteria: [{ criterionId: 'ac1', verdict: 'pass' }] })
  return {
    formatVersion: 1,
    proposalId,
    targetType,
    at: new Date().toISOString(),
    mode: 'executed',
    observed: [{
      taskId: 't-champ',
      candidateTaskId: 't-candidate',
      champion: side('t-champ'),
      candidate: side('t-candidate'),
      verdictMatch: true,
      criteriaDiff: [],
      relation: 'not-worse',
    }],
    holdout: {
      executed: true,
      tasks: [{
        taskId: 't-holdout',
        candidateTaskId: 't-holdout-candidate',
        champion: side('t-holdout'),
        candidate: side('t-holdout-candidate'),
        verdictMatch: true,
        criteriaDiff: [],
        relation: 'not-worse',
      }],
    },
    verdict: 'not-worse',
    ...(targetType === 'skill' && candidateContent !== undefined ? { candidateContent } : {}),
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
 * One directory name throughout (`SKILL`), for the row *and* for the candidate:
 * all four consumers then judge the same bytes under the same name, so the defect
 * they report cannot come from four different inputs.
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

describe('one illegal provider, four consumers, one defect code (S1-C item 3)', () => {
  it.each(ILLEGAL_SHAPES)('$label: admission, config load, capability replacement and promotion all name $defect', async shape => {
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
    //    would be written.
    await capabilityCandidateGated(h, { skills: [SKILL], tools: [...(shape.row[ROW]!.tools ?? [])] })
    let capabilityRefusal = ''
    try {
      await h.evolution.checkPromotion('c1')
    } catch (error) {
      capabilityRefusal = error instanceof Error ? error.message : String(error)
    }
    expect(capabilityRefusal).toContain(`capability "${ROW}"`)
    expect(capabilityRefusal).toContain(`${shape.defect}:`)

    // 4. A candidate promotion: the candidate's own sandbox directory, holding the
    //    same bytes under the name the row grants.
    await skillCandidateGated(h, content)
    await writeSkillDirectory(join(h.evolution.root, 'sandbox', 's1', 'skills', SKILL), SKILL, content, shape.shape)
    let promotionRefusal = ''
    try {
      await h.evolution.checkPromotion('s1')
    } catch (error) {
      promotionRefusal = error instanceof Error ? error.message : String(error)
    }
    expect(promotionRefusal).toContain(`skill candidate "${SKILL}"`)
    expect(promotionRefusal).toContain(`${shape.defect}:`)

    // Four entries, one code — the property a per-entry check could not prove.
    const codes = [shape.defect, shape.defect, shape.defect, shape.defect]
    expect([admission, load.defects[0]!, capabilityRefusal, promotionRefusal].map(entry => codes.find(code => entry.includes(`${code}:`))))
      .toEqual(codes)

    // The same refusal through the tool a human decision goes through, for both
    // candidate kinds: `evolution_decide` runs the promotion check *before* it asks
    // for approval, so a proposal that cannot be promoted never burns a sign-off.
    const toolCtx = { evolution: h.evolution, approval: h.approval, taskRuntime: h.runtime } as never
    for (const proposalId of ['s1', 'c1']) {
      const decided = (await defineEvolutionDecideTool(toolCtx).execute({ proposalId, decision: 'PROMOTE' }, exec(ROOT_SESSION))) as string
      expect(decided).toContain('evolution_decide rejected:')
      expect(decided).toContain(`${shape.defect}:`)
    }
    expect(h.approval.request).not.toHaveBeenCalled()

    // None of the refusals had a side effect: no row written, no production skill,
    // no applied record, no decision recorded, nothing spawned for the refused batch.
    expect(await readFile(h.configFile, 'utf8')).toBe(CONFIG_FIXTURE)
    expect(existsSync(join(h.skillRoot, SKILL, 'SKILL.md'))).toBe(false)
    const ledger = (await readFile(join(h.evolution.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
      .map(line => (JSON.parse(line) as { kind: string }).kind)
    expect(ledger).not.toContain('applied')
    expect(ledger).not.toContain('decided')
    expect(h.taskEvents().filter(event => event.kind === 'CapabilityGapDetected')).toEqual([])
  })

  it('admits, loads, replaces and promotes one legal provider through all four entries', async () => {
    const h = await harness()
    const content = skillText('# a usable execution provider')
    const shape: SkillShape = { sidecar: 'execution', verifierRef: 'command', capabilities: [ROW], requiredTools: ['bash'] }
    await writeSkillDirectory(join(h.checkout, '.agents', 'skills', SKILL), SKILL, content, shape)
    await writeSkillDirectory(join(h.home, 'skills', SKILL), SKILL, content, shape)
    // 1. Admission admits the batch: the provider is discoverable, its verifier is
    //    registered and its required tools are granted by the row that carries it.
    const root = await createRoot(h)
    const outcomes = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT_SESSION, {
      reason: 'the ball needs verifying',
      children: [{
        objective: 'verify the ball',
        acceptanceCriteria: [{ description: 'verified', command: 'true' }],
        requiredCapabilities: [ROW],
      }] as DecomposeSpec['children'],
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    // 2. The config load reports no defect at all for the same table.
    const load = await h.runtime.providerLoadReport()
    expect(load.defects).toEqual([])
    expect(load.failed).toBeUndefined()

    // 3. The capability replacement writes the row and records the role.
    await capabilityCandidateGated(h, { skills: [SKILL], tools: ['filesystem', 'bash'] })
    const check = await h.evolution.checkPromotion('c1')
    expect(check.providers).toMatchObject([{ name: SKILL, role: 'execution-provider', verifierRef: 'command' }])
    await h.evolution.decide('c1', 'PROMOTE', ROOT_SESSION, 'approval:decide')
    const applied = await h.evolution.apply('c1', ROOT_SESSION, 'approval:apply')
    expect(applied.providers).toMatchObject([{ name: SKILL, role: 'execution-provider', verifierRef: 'command' }])
    expect(await readFile(h.configFile, 'utf8')).toContain(`      ${ROW}: { skills: [${SKILL}], tools: [filesystem, bash] }\n`)

    // 4. A skill candidate — in the shape the skill executor promotes, a single
    //    `SKILL.md` — walks the promotion entries through the tools, and the
    //    human who reviews it sees the role the validator counted it as. A
    //    candidate carrying a sidecar or resources is refused here instead
    //    (D1: the executor writes one file, so such a candidate is never
    //    reported as the execution provider it declares itself to be).
    const candidate = skillText('# the candidate the executor can carry', 'verify')
    await skillCandidateGated(h, candidate, 's2', 'verify')
    const toolCtx = { evolution: h.evolution, approval: h.approval, taskRuntime: h.runtime } as never
    const decided = (await defineEvolutionDecideTool(toolCtx).execute({ proposalId: 's2', decision: 'PROMOTE' }, exec(ROOT_SESSION))) as string
    expect(decided).toContain('[decided] PROMOTE')
    const decideReason = (h.approval.request.mock.calls.at(-1)![0] as { reason: string }).reason
    expect(decideReason).toContain('provider: skill `verify` → guidance (no sidecar; loadable guidance, not an execution provider)')

    const appliedViaTool = (await defineEvolutionApplyTool(toolCtx).execute({ proposalId: 's2' }, exec(ROOT_SESSION))) as string
    expect(appliedViaTool).toContain('provider: skill `verify` → guidance')
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
    expect(refusedDecide).toContain('single-file SKILL.md candidates only')
    expect(h.approval.request.mock.calls.length).toBe(approvalsBefore)
    expect((await h.evolution.get('s3')).status).toBe('gated')
    // production still holds exactly what was promoted, and nothing else.
    expect(await readFile(join(h.skillRoot, 'verify', 'SKILL.md'))).toEqual(Buffer.from(candidate, 'utf8'))
  })
})
