import { TASK_GUIDANCE } from '../../task-runtime/tests/support/skill-roots.ts'
import { DEPLOYMENT_MCP_SERVERS } from '../support/mcp-servers.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import SystemPrompt from '../../../../thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../../thirdparty/deepseek-harness/packages/core/tools/lib/index.js'
import { AgentRegistry } from '../../../../thirdparty/deepseek-harness/packages/core/agent/lib/index.js'
import SkillRegistry from '../../../../thirdparty/deepseek-harness/packages/skill/skill/lib/index.js'
import * as SkillFilesystem from '../../../../thirdparty/deepseek-harness/packages/skill/skill-filesystem/lib/index.js'
import { createScope, type Scope } from '../../../../thirdparty/deepseek-harness/packages/core/scope/lib/index.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'
import { listSkillFiles } from '../../agent-runtime/src/skill-file.ts'
import type { EvidenceBundle, TaskEvent, VerificationResult } from '../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../task/src/index.ts'
import type { Config, RootContractSpec } from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { personRequest } from '../../task-runtime/tests/support/person-request.ts'

/**
 * S1-C stage 3 on the full stack: the real `TaskService` store, the real
 * `TaskRuntime` (`decomposeAndRun`), the real `AgentRuntime.spawn` with the real
 * DSH tool/skill planes, and the real filesystem the skills live on. What is
 * replaced is only the model loop: the agent factory mints a scoped world and
 * awaits `setup` — exactly what the loop does before the first prompt — so the
 * skill layer and tool surface asserted here are the ones a live worker would
 * assemble its first request against. `verifyRun` is a scripted verifier, which
 * settles runs without running commands.
 *
 * The claim under test is the stage's headline: the run loads the bytes it was
 * bound to. Three observations have to agree — the record in the store, the
 * snapshot on disk, and what the worker's own skill layer registered — and the
 * production path must be unable to change the third after the fact.
 */

const ROOT_SESSION = 's-root' as SessionId
const STORE = rootTaskStoreId(ROOT_SESSION)

/** Exactly the root agent's allow-list, so the root setup path is exercised for real. */
const ROOT_TOOLS = [
  'graph_spawn', 'graph_mark_ready', 'hitl_ask', 'hitl_approve', 'task_read', 'capability_list', 'task_template_list', 'context_read', 'skill', 'task_intake', 'task_decompose',
  'task_submit_result', 'task_answer', 'task_cancel', 'task_proposal_read', 'task_proposal_continue', 'task_proposal_cancel', 'task_status', 'task_verify', 'task_review_pack', 'task_review_agent', 'task_diagnose', 'task_budget_extend', 'evolution_propose',
  'evolution_candidate', 'evolution_prepare', 'evolution_replay', 'evolution_gate', 'evolution_decide', 'evolution_apply', 'evolution_rollback', 'evolution_list', 'escalate',
]

const GLOBAL_TOOLS = [...ROOT_TOOLS.filter(name => name !== 'skill'), 'session_search', 'session_event_read', 'session_event_trace', 'session_trace']

/** What the `standard`-style preset contributes on its own plane. */
const PRESET_TOOLS = ['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'skill', 'job_output', 'job_list', 'job_kill', 'ask_user_question', 'web_fetch', 'subagent_fetchless']

let workspace: string
let cwd: string
let home: string
let previousHome: string | undefined
const contexts: Context[] = []

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'worker-binding-int-'))
  // The checkout a worker runs in, the env path admission discovers from, and
  // the directory the root agent's cwd resolves to are one directory, as they
  // are in a deployment.
  cwd = join(workspace, 'env')
  home = join(workspace, 'dsh-home')
  mkdirSync(join(home, 'skills'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  rmSync(workspace, { recursive: true, force: true })
})

function tool(name: string) {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: value as string }] },
    execute: async () => name,
  }
}

/** Install one skill where the pre-check's discovery reaches it: the checkout's own project root. */
function install(name: string, body: string): string {
  // The project marker: what the deployment's filesystem skill provider uses to
  // recognize `<checkout>/.agents/skills` as this project's skill root.
  mkdirSync(join(cwd, '.git'), { recursive: true })
  const directory = join(cwd, '.agents', 'skills', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} for the binding test\n---\n\n${body}\n`)
  return directory
}

interface Harness {
  ctx: Context
  runtime: TaskRuntime
  task: TaskService
  /** One entry per worker the cascade actually spawned, in spawn order. */
  spawned: SessionId[]
  /** The live agent for one session, as the deployment's registry holds it. */
  agent(sessionId: SessionId): Agent | undefined
  /** The tool names one worker's composition offers. */
  visible(agent: Agent): string[]
  /** Every task event the store appended, read back off its own session log. */
  events(): TaskEvent[]
}

async function harness(options: { capabilities?: Record<string, { skills?: string[]; tools?: string[] }>; bindingRoot?: string; discovery?: boolean } = {}): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry, {})
  // The deployment's own filesystem skill provider, when the test wants the
  // catalog to be real: without it only registered skills exist, and "a worker
  // can see an unselected skill" is not a fact this harness could establish.
  if (options.discovery === true) {
    await ctx.plugin(SkillFilesystem, { dshHome: home, agentsHome: join(workspace, 'agents-home'), watch: false })
  }
  for (const name of GLOBAL_TOOLS) ctx.tools.register(tool(name))
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) })
  ctx.provide('agentPresets', { defaultId: 'standard', mount: async () => {}, resolve: async () => ({}) })
  ctx.provide('permissionPresets', { set: vi.fn(), resolve: () => ({}) })
  ctx.provide('sessions', {})

  const log = new Map<string, SessionEvent[]>()
  const headers = new Map<string, SessionHeader>([[ROOT_SESSION, { id: ROOT_SESSION, cwd, agentPreset: 'standard' }]])
  // The person's request, on the root session's own durable log: what a root
  // contract's origin is read from (A0 §1.10). The rule is the *existence* of a
  // user-sourced message, so one text stands for the request these cases intake on.
  log.set(ROOT_SESSION, [personRequest('ship the release')])
  ctx.provide('sessionPersistence', {
    list: async () => [...headers.values()].map(header => ({ header })),
    create: async (header: SessionHeader) => {
      headers.set(header.id, header)
      log.set(header.id, [])
      return handle(header.id)
    },
    open: async (id: SessionId) => {
      if (!log.has(id)) throw new Error(`missing session ${id}`)
      return handle(id)
    },
  } as never)
  const handle = (id: SessionId) => ({
    read: async () => ({ events: log.get(id) ?? [] }),
    append: async (records: readonly SessionEvent[]) => { log.get(id)?.push(...records) },
    flush: async () => {},
    close: async () => {},
  })
  ctx.provide('layout', { setIn: async () => {} })
  const graphAgents = [{ id: ROOT_SESSION, name: 'Singularity', status: 'idle' as const }]
  ctx.provide('graph', {
    snapshotIn: async () => ({ version: 1, id: 'g', roots: [ROOT_SESSION], agents: [...graphAgents], groups: [], edges: [] }),
    commitIn: async () => {},
    setStatusIn: async () => {},
    addAgentIn: async () => {},
  } as never)
  // The graph the task runtime reads: one env, whose checkout is this test's
  // worker cwd — the same directory the pre-check discovers from and the
  // snapshot lives outside of.
  ctx.provide('graphs', {
    graphForSession: async () => ({ id: 'g1', name: 'graph', envId: 'env1', rootSessionId: ROOT_SESSION, graphStoreId: 'sg-g-root', layoutStoreId: 'sg-l-root' }),
  } as never)
  ctx.provide('envBuilder', { store: { get: (envId: string) => (envId === 'env1' ? { path: cwd, components: [] } : undefined) } } as never)

  // A preset's standing mount lives in its own scope; an agent joins it by scope parentage.
  const presetKey = { id: 'preset:standard' }
  let presetScope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { presetScope = createScope(inner, presetKey) }, { inject: ['tools', 'systemPrompt'] }))
  for (const name of PRESET_TOOLS) presetScope.ctx.tools.register(tool(name))
  const rootPresetKey = { id: 'preset:root-standard' }
  await ctx.plugin(Object.assign((inner: Context) => {
    const rootPresetScope = createScope(inner, rootPresetKey)
    for (const name of PRESET_TOOLS) rootPresetScope.ctx.tools.register(tool(name))
  }, { inject: ['tools', 'systemPrompt'] }))

  const agentRuntime = new AgentRuntime(ctx)
  const task = new TaskService(ctx)
  await writeEvidenceVerifier(ctx, task)

  const config: Partial<Config> = {
    capabilities: { ...TASK_GUIDANCE, ...(options.capabilities ?? { 'design-ball': { skills: ['ball-align'], tools: ['filesystem'] } }) },
    ...(options.bindingRoot === undefined ? {} : { runBindingRoot: options.bindingRoot }),
  }
  const runtime = new TaskRuntime(ctx, { mcpServers: DEPLOYMENT_MCP_SERVERS, ...config } as Config)

  // The model loop is the one thing replaced: the factory mints the scoped world
  // and awaits `setup`, which is where a capability grant composes the worker.
  const live = new Map<string, Agent>()
  const spawned: SessionId[] = []
  const mint = async (sessionId: SessionId, setup: ((agentCtx: Context, agent: Agent) => Promise<unknown>) | undefined): Promise<Agent> => {
    const agent = {
      id: sessionId,
      followup: vi.fn(),
      cancel: vi.fn(),
      append: vi.fn(),
      // A live worker hands its result in before it goes idle (A3 §3.2): an
      // idle session is not a completion, so a stub that only went idle would
      // be stopped by the no-progress rule instead of being verified.
      whenIdle: async () => { await runtime.submitResult(sessionId, { summary: 'worker finished (fixture auto-submit)' }) },
      session: { id: sessionId, header: { id: sessionId, cwd, agentPreset: 'standard' }, append: vi.fn() },
    } as unknown as Agent
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => {
      scope = createScope(inner, agent, { parent: sessionId === ROOT_SESSION ? rootPresetKey : presetKey })
    }, { inject: ['tools', 'systemPrompt'] }))
    Object.assign(agent as object, { ctx: scope.ctx })
    await setup?.(scope.ctx, agent)
    await (ctx.agents.register(agent) as unknown as Promise<void>)
    live.set(sessionId, agent)
    if (sessionId !== ROOT_SESSION) spawned.push(sessionId)
    return agent
  }
  ctx.agents.setFactory({
    createAgent: async (_ownerCtx: Context, options: { sessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
      ({ agent: await mint(options.sessionId, options.setup), dispose: async () => { live.delete(options.sessionId) } }),
    resume: async (_ownerCtx: Context, options: { resumeSessionId: SessionId; setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> }) =>
      ({ agent: await mint(options.resumeSessionId, options.setup), dispose: async () => { live.delete(options.resumeSessionId) } }),
  } as never)
  const agents = ctx.agents as unknown as { get(id: SessionId): Agent | undefined }
  await agentRuntime.ensureRoot(ROOT_SESSION, { graphStoreId: 'g', layoutStoreId: 'l' })

  return {
    ctx,
    runtime,
    task,
    spawned,
    agent: sessionId => agents.get(sessionId),
    visible: agent => ctx.tools.schemas(agent).map(schema => schema.name),
    events: () => (log.get(STORE) ?? []).flatMap(event => (event.type === 'task/event' ? [event.data as unknown as TaskEvent] : [])),
  }
}

/** A scripted verifier: pass every criterion, record the evidence the store needs, and report the bundle. */
async function writeEvidenceVerifier(ctx: Context, task: TaskService): Promise<void> {
  ctx.provide('verifier', {
    verifierIds: () => ['command', 'composite', 'review'],
    verifyRun: async (storeId: string, runId: string): Promise<EvidenceBundle> => {
      const run = await task.runIn(storeId, runId)
      const instance = await task.taskIn(storeId, run.taskId)
      const verifierResults: VerificationResult[] = instance.acceptanceCriteria.map(criterion => ({
        criterionId: criterion.criterionId,
        status: 'pass',
        verifierId: 'scripted-verifier',
      }))
      const bundle: EvidenceBundle = {
        evidenceId: `e-${runId}`,
        taskRunId: runId,
        taskId: run.taskId,
        artifacts: [],
        verifierResults,
        claims: verifierResults.map(result => ({
          claimId: `claim-${result.criterionId}`,
          criterionId: result.criterionId,
          status: result.status,
          verifierId: 'scripted-verifier',
          artifactRefs: [],
        })),
        generatedAt: new Date().toISOString(),
      }
      await task.recordEvidenceIn(storeId, bundle, 'scripted-verifier')
      return bundle
    },
  } as never)
}

function child(objective: string, requiredCapabilities: readonly string[]) {
  return {
    objective,
    acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
    requiredCapabilities,
  }
}

async function runOne(h: Harness, objective = 'align the ball', capabilities: readonly string[] = ['design-ball']): Promise<{ taskId: string; runId: string }> {
  const { taskId, runId } = await activateRoot(h)
  const batch = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
    reason: 'split the work',
    children: [child(objective, capabilities)],
  })
  const outcomes = await h.runtime.awaitBatch(STORE, batch.batchId)
  expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
  // The batch end hands the root back `active` and judges nothing (K1 §2): the
  // root's own submission settles it, and with it the hold this store's run has
  // on the checkout — the fact a second store in the same deployment waits for.
  await h.runtime.submitResult(ROOT_SESSION, { summary: 'the tree hands in the result its batch produced' })
  const childTaskId = outcomes[0]!.taskId
  const childRunId = outcomes[0]!.runId!
  return { taskId: childTaskId, runId: childRunId }
}

/** The body the worker's own skill layer holds for one skill, as the registry serves it. */
async function registeredSkill(h: Harness, agent: Agent, name: string): Promise<{ content: string; path?: string; resourceBase?: { path: string } }> {
  const skill = await h.ctx.skills.get(name, { scope: agent, cwd })
  if (skill === undefined) throw new Error(`the worker's skill layer holds no "${name}"`)
  return skill as { content: string; path?: string; resourceBase?: { path: string } }
}


/**
 * The root contract this spec's trees run under (A0 §1.2): one goal, one
 * criterion a command settles — and the conjunction, because these cases read
 * the root's own acceptance off the children's verdicts. The intake is real, so
 * the contract is stated here rather than defaulted.
 */
function rootContract(objective: string): RootContractSpec {
  return { requiredCapabilities: ['execute-task'],
    objective,
    acceptanceCriteria: [
      { criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' },
      { criterionId: 'root-children-verified', description: 'all mandatory children verified', mode: 'composite', mandatory: true },
    ],
  }
}

/** Activate a root through the real intake and hand back what it became. */
async function activateRoot(h: Harness, objective = 'ship the release'): Promise<{ taskId: string; runId: string }> {
  const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract(objective))
  if (activated.status !== 'activated') throw new Error(`the root contract was not activated: ${activated.detail}`)
  return { taskId: activated.taskId, runId: activated.runId }
}

describe('the content a worker loads (S1-C)', () => {
  it('registers the run\'s own snapshot of the granted skill, with the identity the run recorded', async () => {
    install('ball-align', 'ADMITTED BODY')
    const h = await harness()
    const { runId } = await runOne(h)

    const run = await h.task.runIn(STORE, runId)
    const binding = run.providerBinding
    if (binding === undefined) throw new Error('the run recorded no provider binding')
    expect(binding.skills.map(skill => skill.name)).toEqual(['ball-align'])
    expect(binding.snapshotRoot).toBeDefined()

    const worker = h.agent(run.sessionId as SessionId)!
    const registered = await registeredSkill(h, worker, 'ball-align')
    expect(registered.content).toContain('ADMITTED BODY')
    // The worker's copy comes from the snapshot, not from the checkout: the
    // resource base and the file it was read from both sit in the run's own
    // directory, which is outside the worker's checkout.
    expect(registered.path!.startsWith(binding.snapshotRoot!)).toBe(true)
    expect(registered.resourceBase!.path.startsWith(binding.snapshotRoot!)).toBe(true)
    expect(registered.path!.startsWith(cwd)).toBe(false)

    // And the record's own re-check of those bytes is clean.
    expect((await h.runtime.readRunBinding(binding))?.defects).toEqual([])
  })

  it('keeps the bound bytes after the production skill is rewritten, and binds the new bytes for a new run', async () => {
    const directory = install('ball-align', 'ADMITTED BODY')
    const h = await harness()
    const first = await runOne(h)
    const firstBinding = (await h.task.runIn(STORE, first.runId)).providerBinding!
    const firstWorker = h.agent((await h.task.runIn(STORE, first.runId)).sessionId as SessionId)!

    // The evolution-apply shape: the production file is rewritten while the run
    // is live and after it finished.
    await writeFile(join(directory, 'SKILL.md'), '---\nname: ball-align\ndescription: rewritten\n---\n\nREPLACED BODY\n')

    // The in-flight worker's layer still holds the admitted bytes…
    expect((await registeredSkill(h, firstWorker, 'ball-align')).content).toContain('ADMITTED BODY')
    // …the snapshot is untouched…
    expect(await readFile(join(firstBinding.snapshotRoot!, 'ball-align', 'SKILL.md'), 'utf8')).toContain('ADMITTED BODY')
    // …and the record still describes exactly those bytes.
    expect((await h.runtime.readRunBinding(firstBinding))?.defects).toEqual([])

    // …and a run admitted afterwards binds the new bytes: a version change is a
    // new run, never a hot swap of the old one. (A parent decomposes once, so
    // the second admission belongs to its own store in the same deployment.)
    const next = await harness()
    const second = await runOne(next, 'align the ball again')
    const secondBinding = (await next.task.runIn(STORE, second.runId)).providerBinding!
    expect(secondBinding.skills[0]!.contentDigest).not.toBe(firstBinding.skills[0]!.contentDigest)
    const secondWorker = next.agent((await next.task.runIn(STORE, second.runId)).sessionId as SessionId)!
    expect((await registeredSkill(next, secondWorker, 'ball-align')).content).toContain('REPLACED BODY')
  })

  it('refuses to read back a snapshot that was removed or edited, naming the skill and the path', async () => {
    install('ball-align', 'ADMITTED BODY')
    const h = await harness()
    const { runId } = await runOne(h)
    const binding = (await h.task.runIn(STORE, runId)).providerBinding!
    const file = join(binding.snapshotRoot!, 'ball-align', 'SKILL.md')

    // Edited: the bytes no longer answer to the record.
    await writeFile(file, '---\nname: ball-align\ndescription: tampered\n---\n\nTAMPERED\n')
    const edited = await h.runtime.readRunBinding(binding)
    expect(edited?.defects.length).toBeGreaterThan(0)
    expect(edited!.defects.join('\n')).toContain('ball-align')
    expect(edited!.defects.join('\n')).toContain('SKILL.md')
    expect(edited!.skills[0]!.readable).toBe(false)

    // Removed: absence is reported, never a fallback to the production path.
    await rm(binding.snapshotRoot!, { recursive: true, force: true })
    const missing = await h.runtime.readRunBinding(binding)
    expect(missing!.defects.join('\n')).toContain(binding.snapshotRoot!)
    expect(missing!.skills[0]!.readable).toBe(false)
  })

  it('does not widen one worker\'s tool surface when another skill is loaded from the deployment catalog', async () => {
    install('ball-align', 'ADMITTED BODY')
    // A skill the deployment catalog holds but no capability of this run grants.
    install('other-skill', 'NOT SELECTED')
    const h = await harness({ discovery: true })
    const { runId } = await runOne(h)
    const sessionId = (await h.task.runIn(STORE, runId)).sessionId as SessionId
    const worker = h.agent(sessionId)!

    const before = h.visible(worker)
    // The unselected skill stays reachable from the deployment's own catalog
    // (DSH has no per-agent hiding — the honest boundary)…
    const other = await h.ctx.skills.get('other-skill', { scope: worker, cwd })
    expect(other).toBeDefined()
    // …while the run's snapshot holds exactly the bound skill, so nothing else
    // can reach the worker's own layer through this run's skill roots.
    const binding = (await h.task.runIn(STORE, runId)).providerBinding!
    expect((await listSkillFiles(binding.snapshotRoot!)).map(file => file.name)).toEqual(['ball-align'])
    expect(binding.skills.map(skill => skill.name)).toEqual(['ball-align'])

    // Loading it changes nothing about what the worker may call: authorization
    // is the capability grant, and a skill body is content, not a permission.
    expect(h.visible(worker)).toEqual(before)
    for (const name of before) {
      expect(['graph_spawn', 'evolution_decide', 'evolution_apply', 'task_review_pack', 'task_diagnose', 'hitl_ask', 'escalate']).not.toContain(name)
    }
    expect(before).toContain('read')
    expect(before).toContain('capability_list')
  })
})

describe('the binding record (S1-C)', () => {
  it('is written for the child run and the root run from the same builder, and persists as store state', async () => {
    install('ball-align', 'ADMITTED BODY')
    const h = await harness()
    const { taskId, runId: rootRunId } = await activateRoot(h)
    const rootRun = await h.task.runIn(STORE, rootRunId)
    // The root explicitly selects its Task method and freezes those instructions.
    expect(rootRun.capabilitySnapshot).toEqual(['task-execution'])
    expect(rootRun.providerBinding!.skills.map(skill => skill.name)).toEqual(['task-execution'])
    expect(rootRun.providerBinding!.mcpServers).toEqual([])
    expect(rootRun.providerBinding!.snapshotRoot).toBeDefined()
    expect(rootRun.providerBinding!.registryRevision).toMatch(/^[0-9a-f]{64}$/)

    const batch = await h.runtime.decomposeAndRun(STORE, taskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [child('align the ball', ['design-ball'])],
    })
    const outcomes = await h.runtime.awaitBatch(STORE, batch.batchId)
    const childRunId = outcomes[0]!.runId!

    // The record is on the event log, not in the writer's memory: the event the
    // store appended carries the same binding a re-read of the store returns.
    const started = h.events().find(event => event.kind === 'TaskStarted' && event.runId === childRunId)
    if (started?.kind !== 'TaskStarted') throw new Error('the store holds no TaskStarted event for the child run')
    expect(started.payload.run.providerBinding).toEqual((await h.task.runIn(STORE, childRunId)).providerBinding)
    expect(started.payload.run.providerBinding!.snapshotRoot).toBeDefined()

    // A second service over the same session log reads the same record: the
    // binding is store state, not process state.
    const reopened = await h.task.openStore(STORE)
    expect(reopened.runs.find(run => run.runId === childRunId)?.providerBinding)
      .toEqual((await h.task.runIn(STORE, childRunId)).providerBinding)
  })

  it('records the MCP servers the run granted, with the template identity they resolved to', async () => {
    // The grant itself is asserted where the spawn request can be inspected
    // without starting a real MCP server (`orchestrate.spec.ts`); here the claim
    // is the record: the server name and the registry template it resolved to.
    install('ball-align', 'ADMITTED BODY')
    const h = await harness({
      capabilities: { 'check-ball-registration': { skills: ['ball-align'], tools: ['filesystem', 'bash', 'jobs'], mcpServers: ['bbdev'] } },
    })
    const { taskId, runId } = await activateRoot(h)
    const batch = await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [child('check the registration', ['check-ball-registration'])],
    })
    const outcomes = await h.runtime.awaitBatch(STORE, batch.batchId)
    const binding = (await h.task.runIn(STORE, outcomes[0]!.runId!)).providerBinding!
    expect(binding.skills.map(skill => skill.name)).toEqual(['ball-align'])
    expect(binding.mcpServers).toHaveLength(1)
    expect(binding.mcpServers[0]!.serverName).toBe('bbdev')
    expect(binding.mcpServers[0]!.templateDigest).toMatch(/^[0-9a-f]{64}$/)
    // The name still travels in the capability snapshot the run already recorded.
    expect((await h.task.runIn(STORE, outcomes[0]!.runId!)).capabilitySnapshot).toContain('mcp:bbdev')
  })

  it('records the same binding for a criteria replay, so the record means one thing whatever the spawn mode', async () => {
    install('ball-align', 'ADMITTED BODY')
    const h = await harness()
    const champion = await runOne(h)
    const outcome = await h.runtime.replayTask(STORE, champion.taskId, {
      lineage: 'evolution-replay:binding',
      spawn: false,
      contract: {
        objective: 'replay the champion criteria',
        acceptanceCriteria: [{ criterionId: 'r-1', description: 'holds', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' }],
        requiredCapabilities: ['design-ball'],
      },
    }, ROOT_SESSION)

    expect(outcome.status).toBe('verified')
    const run = await h.task.runIn(STORE, outcome.runId)
    expect(run.providerBinding!.skills.map(skill => skill.name)).toEqual(['ball-align'])
    expect(run.providerBinding!.snapshotRoot).toBeDefined()
    expect((await h.runtime.readRunBinding(run.providerBinding!))?.defects).toEqual([])
    // No worker was spawned for the replay: the record says what the replay
    // resolved against, and nothing claims a worker loaded it.
    expect(h.spawned).toHaveLength(1)
  })

  it('refuses to hand a re-entered run back when the content its record names is not readable', async () => {
    install('ball-align', 'ADMITTED BODY')
    const h = await harness()
    // A store whose root task already carries a run for this session — the state
    // a restart finds — with a binding whose content is not on disk.
    const missing = join(home, 'singularity', 'run-bindings', STORE, 'r-gone', 'skills')
    await h.task.createStore(STORE)
    const rootTaskId = 't-root-seeded'
    await h.task.createTaskIn(STORE, {
      taskId: rootTaskId,
      definitionRef: { taskType: 'root', version: 1 },
      objective: 'ship the release',
      depth: 0,
      acceptanceCriteria: [{ criterionId: 'root-children-verified', description: 'all mandatory children verified', verificationMode: 'composite', requiredEvidence: [], mandatory: true }],
      requestedCapabilities: ['execute-task'],
      decompositionStatus: 'decomposable',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, ROOT_SESSION)
    await h.task.admitTaskIn(STORE, rootTaskId, ROOT_SESSION, { decompositionStatus: 'decomposable' })
    await h.task.startRunIn(STORE, {
      runId: 'r-gone',
      taskId: rootTaskId,
      sessionId: ROOT_SESSION,
      capabilitySnapshot: ['ball-align'],
      providerBinding: {
        registryRevision: 'a'.repeat(64),
        capabilities: ['design-ball'],
        skills: [{
          name: 'ball-align',
          role: 'guidance',
          capabilities: ['design-ball'],
          description: 'Align a Buckyball Ball',
          contractDigest: null,
          contentDigest: 'b'.repeat(64),
          uncovered: [],
        }],
        mcpServers: [],
        snapshotRoot: missing,
      },
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    }, ROOT_SESSION)

    // Adoption is the re-entry: it opens the store, re-checks the content the run's
    // binding names, and only then hands the run back.
    await expect(h.runtime.adoptRoot(STORE, ROOT_SESSION)).rejects.toThrow(/ball-align/)
    await expect(h.runtime.adoptRoot(STORE, ROOT_SESSION))
      .rejects.toThrow(new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    // The same store hands back its root run when the record names nothing:
    // there is no content to re-check, so a re-entry is not refused.
    const plain = await harness()
    const first = await activateRoot(plain)
    await expect(plain.runtime.adoptRoot(STORE, ROOT_SESSION)).resolves
      .toMatchObject({ adopted: true, taskId: first.taskId, runId: first.runId })
  })
})
