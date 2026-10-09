import { TASK_GUIDANCE } from '../../task-runtime/tests/support/skill-roots.ts'
import { DEPLOYMENT_MCP_SERVERS } from '../support/mcp-servers.ts'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SingularityAgent } from '../../agent-singularity/src/index.ts'
import type { TaskEvent, TaskSnapshot } from '../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../task/src/index.ts'
import type { CapabilityConfig, CapabilityProviderPrecheck, Config, DecomposeSpec, SkillProviderVerdict, RootContractSpec } from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'
import { graphRegistry, mountContextReadCore, sessionQueryReads } from '../support/context-plane.ts'
import { personRequest } from '../../task-runtime/tests/support/person-request.ts'

/**
 * S1-C slice 2 end to end: the admission-time provider pre-check on the real
 * chain — the real `TaskService` store and reducer, the real `TaskRuntime`
 * entries (`decomposeAndRun`, `replayTask`, and the same runtime behind the
 * `task_decompose` tool), the real `VerifierRegistry` with its real
 * `CommandVerifier` and `CompositeVerifier`, and real skill directories holding
 * the phase-1 fixtures, discovered from the checkout the workers run in.
 *
 * What is real: the filesystem discovery (`agent-runtime/src/skill-file.ts`
 * through the runtime's pre-check), the sidecar loader and validator, the
 * capability table, admission, the cascade, verification, and the persisted
 * event log this file asserts against.
 *
 * What is stubbed, and why: `sessionPersistence` (an in-memory handle, the same
 * shape the JSONL log has), `agentRuntime.spawn` (no model loop runs here), the
 * `agents` lookup (a spawned worker's agent), and `graphs`/`envBuilder` (a fixed
 * env binding whose checkout is this test's tmp directory — which is exactly the
 * directory a worker's cwd resolves to in a real graph).
 *
 * Every refusal is asserted twice: the message it names, and the absence of the
 * writes a refused batch must not perform — read back from the store's own task
 * events, snapshot and obligations, never from the writer's return value.
 */

const ROOT_SESSION = 's-root'
const STORE = rootTaskStoreId(ROOT_SESSION)
const FIXTURE_SKILLS = fileURLToPath(new URL('../../task-runtime/tests/fixtures/skills/', import.meta.url))

/** The wrapper the tool puts around a refusal it caught (`agent-singularity/src/tools/task-decompose.ts`). */
const TOOL_REJECTION = 'task_decompose rejected: '

interface SpawnRequest {
  sessionId: string
  grant?: { skillRoots?: readonly string[]; mcpServers?: readonly { serverName: string }[]; capabilities: readonly { skills: readonly string[] }[] }
}

interface Harness {
  task: TaskService
  runtime: TaskRuntime
  verifier: VerifierRegistry
  log: Map<string, SessionEvent[]>
  spawned: SpawnRequest[]
  /** The tool registry stand-in; populated only when the generation mounts the root agent. */
  tools: Map<string, { execute(args: Record<string, unknown>, exec?: unknown): unknown }>
}

const contexts: Context[] = []
let workspace: string
let home: string
let checkout: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'provider-precheck-'))
  home = join(workspace, 'home')
  checkout = join(workspace, 'env')
  await mkdir(join(home, 'skills'), { recursive: true })
  // The env's own buckyball checkout: the bbdev MCP server binds `{repoRoot:buckyball}`.
  await mkdir(join(checkout, 'buckyball'), { recursive: true })
  // Both roots the discovery reaches beyond the checkout are pinned inside this
  // test's tmp fixture — `$DSH_HOME/skills` and the user root `~/.agents/skills`
  // — so a skill installed on the machine running the suite can never decide
  // whether a batch is admitted or refused.
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(workspace, { recursive: true, force: true })
})

/**
 * Install one fixture skill where a worker's discovery would find it: under the
 * checkout's project skill root, under the deployment's `$DSH_HOME/skills`, or
 * under the user root `~/.agents/skills`. `sidecar: false` installs the
 * `SKILL.md` alone — a guidance skill, the shape a deployment's own reference
 * skills have.
 */
async function install(name: string, options: { at?: 'checkout' | 'home' | 'user'; sidecar?: boolean } = {}): Promise<string> {
  const root = options.at === 'home'
    ? join(home, 'skills')
    : options.at === 'user'
      ? join(home, '.agents', 'skills')
      : join(checkout, '.agents', 'skills')
  const directory = join(root, name)
  await cp(join(FIXTURE_SKILLS, name), directory, { recursive: true })
  if (options.sidecar === false) await rm(join(directory, 'SKILL.contract.json'))
  return directory
}

/** Read one installed sidecar, change it, write it back — a declaration that still describes its content. */
async function patchSidecar(directory: string, patch: (sidecar: Record<string, unknown>) => void): Promise<void> {
  const file = join(directory, 'SKILL.contract.json')
  const sidecar = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  patch(sidecar)
  await writeFile(file, JSON.stringify(sidecar, null, 2))
}

/** The real execution-provider row: the `verify` fixture's own declared capability, with the tools and server it requires. */
const VERIFY_ROW: CapabilityConfig = { skills: ['verify'], tools: ['filesystem', 'bash', 'jobs'], preset: 'bb-verify', mcpServers: ['bbdev'] }

const DEFAULT_ROWS: Readonly<Record<string, CapabilityConfig>> = {
  'verify-ball-functional': VERIFY_ROW,
  'design-ball': { skills: ['ball-align'], tools: ['filesystem', 'bash'] },
  'integrate-model': { skills: ['workload-tests'] },
}

async function harness(options: { capabilities?: Record<string, CapabilityConfig>; mountAgent?: boolean } = {}): Promise<Harness> {
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

  const spawned: SpawnRequest[] = []
  ctx.provide('agentRuntime', {
    spawn: async (_parent: unknown, request: SpawnRequest) => {
      spawned.push(request)
      return {
        agent: {
          id: request.sessionId,
          cancel: () => {},
          // A live worker hands its result in before it goes idle (A3 §3.2): an
          // idle session is not a completion, so a stub that only went idle would
          // be stopped by the no-progress rule instead of being verified.
          whenIdle: async () => { await runtime.submitResult(request.sessionId, { summary: 'worker finished (fixture auto-submit)' }) },
        },
        dispose: async () => {},
      }
    },
  } as never)
  ctx.provide('agents', { get: (sessionId: string) => ({ id: sessionId }) } as never)
  ctx.provide('graphs', graphRegistry({
    graphForSession: async () => ({ id: 'g1', name: 'graph', envId: 'env1', rootSessionId: ROOT_SESSION }),
    members: () => [ROOT_SESSION, ...headers.keys()],
  }) as never)
  ctx.provide('sessionQuery', sessionQueryReads(sessionId => log.get(String(sessionId))) as never)
  // The env binding the session's checkout comes from: the same source the
  // verifier's cwd and the protected-input fixing read, and the directory the
  // pre-check discovers skills from.
  ctx.provide('envBuilder', {
    store: { get: (envId: string) => (envId === 'env1' ? { path: checkout, components: [{ repo: 'buckyball', dir: 'buckyball' }] } : undefined) },
  } as never)

  const tools = new Map<string, { execute(args: Record<string, unknown>, exec?: unknown): unknown }>()
  if (options.mountAgent === true) {
    ctx.provide('tools', {
      register: (tool: { name: string; execute: (args: Record<string, unknown>, exec?: unknown) => unknown }) => {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    } as never)
    ctx.provide('userQuestions', { ask: async () => ({ answers: [] }) } as never)
    ctx.provide('approval', { request: async () => 'allowed-once' } as never)
  }

  const task = new TaskService(ctx)
  const verifier = new VerifierRegistry(ctx, { evidenceRoot: join(workspace, 'evidence') })
  // Cordis readies the service when it loads the plugin; a hand-built registry
  // has to be readied explicitly, or `verifierIds()` reports no vocabulary —
  // and the pre-check would refuse every execution provider on a deployment
  // whose registry is merely still loading.
  await verifier.ready()
  const config: Partial<Config> = { capabilities: { ...TASK_GUIDANCE, ...DEFAULT_ROWS, ...(options.capabilities ?? {}) } }
  const runtime = new TaskRuntime(ctx, { mcpServers: DEPLOYMENT_MCP_SERVERS, ...config } as Config)
  if (options.mountAgent === true) {
    // The read core and its assembly, mounted where the deployment's bundle mounts
    // them: the plugin's tool adapters read through this service (A2).
    await mountContextReadCore(ctx)
    await ctx.plugin(SingularityAgent)
  }
  return { task, runtime, verifier, log, spawned, tools }
}

/** Every task event the store actually appended, read back off its session log. */
function taskEvents(h: Harness): TaskEvent[] {
  return [...h.log.values()].flatMap(events => events.flatMap(event =>
    event.type === 'task/event' ? [event.data as unknown as TaskEvent] : []))
}

/**
 * The root task plus the run every entry resolves the caller through — activated
 * through the real intake (A0 §1.2) with this spec's own contract. The contract
 * is stated here rather than defaulted: a root contract owes at least one
 * mandatory criterion judged by something other than the composite conjunction.
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

function child(objective: string, requiredCapabilities: readonly string[], overrides: Record<string, unknown> = {}) {
  return {
    objective,
    acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
    requiredCapabilities,
    ...overrides,
  } as DecomposeSpec['children'][number]
}

/** The one deterministic criterion a replay contract carries — a replay without a criterion is refused before its capabilities are ever read. */
const REPLAY_CRITERION = {
  criterionId: 'replay-1',
  description: 'the replayed work holds',
  verificationMode: 'deterministic' as const,
  requiredEvidence: [],
  mandatory: true,
  command: 'true',
}

/** Drive the runtime directly and return its refusal; an admitted batch is this test's own failure. */
async function refusalOf(h: Harness, root: { storeId: string; taskId: string; runId: string }, children: DecomposeSpec['children']): Promise<string> {
  try {
    await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT_SESSION, { reason: 'split the work', children })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('the runtime admitted a batch it was supposed to refuse')
}

/** The store's snapshot plus the events it holds: what a refused entry must leave exactly as it found. */
async function storeState(h: Harness): Promise<{ events: TaskEvent[]; snapshot: TaskSnapshot }> {
  return { events: taskEvents(h), snapshot: await h.task.snapshotIn(STORE) }
}

/** One skill's verdict inside a report row; a name the report never reached is this test's own failure. */
function verdictOf(row: CapabilityProviderPrecheck, name: string): SkillProviderVerdict {
  const verdict = row.skills.find(item => item.name === name)
  if (verdict === undefined) throw new Error(`the report holds no verdict for skill "${name}"`)
  return verdict
}

describe('admission provider pre-check (S1-C)', () => {
  it('admits an execution provider found from the worker\'s own checkout, and the spawn still gets the grant', async () => {
    await install('verify', { at: 'checkout' })
    const h = await harness()
    const root = await createRoot(h)

    const batch = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT_SESSION, {
      reason: 'the ball needs verifying',
      children: [child('verify the ball', ['verify-ball-functional'])],
    })
    const outcomes = await h.runtime.awaitBatch(root.storeId, batch.batchId)

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]!.grant!.capabilities).toEqual([{ capability: 'verify-ball-functional', tools: ['read', 'write', 'edit', 'bash', 'job_output', 'job_list', 'job_kill'], skills: ['verify'] }])
    // The MCP plane the sidecar's required tools ride on is the same run env the
    // pre-check discovered the skill from.
    expect(h.spawned[0]!.grant!.mcpServers!.map(server => server.serverName)).toEqual(['bbdev'])

    // The admission facts are the store's, not the writer's: the capability was
    // resolved and no gap was ever found.
    const childTaskId = outcomes[0]!.taskId
    const resolved = taskEvents(h).find(event => event.kind === 'CapabilityResolved' && event.taskId === childTaskId)
    expect(resolved?.kind === 'CapabilityResolved' ? resolved.payload.manifest.closure : undefined).toBe('closed')
    expect(taskEvents(h).filter(event => event.kind === 'CapabilityGapDetected')).toEqual([])
  })

  it('admits a knowledge provider and reports it as knowledge, never as an execution provider', async () => {
    const directory = await install('ball-align', { at: 'checkout' })
    const h = await harness()
    const root = await createRoot(h)

    const batch = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT_SESSION, {
      reason: 'design the ball',
      children: [child('design the ball', ['design-ball'])],
    })
    const outcomes = await h.runtime.awaitBatch(root.storeId, batch.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    const report = await h.runtime.capabilityProviderReport(ROOT_SESSION)
    const row = report.capabilities.find(item => item.capability === 'design-ball')!
    expect(row.skills.map(verdict => (verdict.valid ? verdict.role : 'invalid'))).toEqual(['knowledge'])
    expect(verdictOf(row, 'ball-align')).toMatchObject({ role: 'knowledge', directory })
  })

  it('admits a skill that declares no sidecar as guidance', async () => {
    await install('ball-align', { at: 'checkout', sidecar: false })
    const h = await harness()
    const root = await createRoot(h)

    const batch = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT_SESSION, {
      reason: 'design the ball',
      children: [child('design the ball', ['design-ball'])],
    })
    const outcomes = await h.runtime.awaitBatch(root.storeId, batch.batchId)

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    const report = await h.runtime.capabilityProviderReport(ROOT_SESSION)
    expect(verdictOf(report.capabilities.find(item => item.capability === 'design-ball')!, 'ball-align')).toMatchObject({
      role: 'guidance',
      uncovered: [],
    })
  })

  it('searches the deployment skill home and the user root too, not only the checkout', async () => {
    await install('ball-align', { at: 'home' })
    const h = await harness()
    const root = await createRoot(h)

    const batch = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT_SESSION, {
      reason: 'design the ball',
      children: [child('design the ball', ['design-ball'])],
    })
    const outcomes = await h.runtime.awaitBatch(root.storeId, batch.batchId)

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
  })

  it('finds a skill in the user root as well', async () => {
    await install('workload-tests', { at: 'user' })
    const h = await harness()
    const root = await createRoot(h)

    const report = await h.runtime.capabilityProviderReport(ROOT_SESSION)
    expect(verdictOf(report.capabilities.find(item => item.capability === 'integrate-model')!, 'workload-tests')).toMatchObject({
      role: 'knowledge',
    })
  })

  it('refuses the whole batch when a granted skill is not discoverable, naming the capability, the skill and the roots', async () => {
    const h = await harness({ capabilities: { 'design-ball': { skills: ['missing-provider-skill'] } } })
    const root = await createRoot(h)
    const before = await storeState(h)

    const refusal = await refusalOf(h, root, [child('design the ball', ['design-ball'])])

    expect(refusal).toContain('provider pre-check rejected decomposition')
    expect(refusal).toContain('capability "design-ball"')
    expect(refusal).toContain('skill "missing-provider-skill"')
    expect(refusal).toContain('skill-missing')
    // Every root the search covered is named: the checkout's own, the
    // deployment's skill home and the user root.
    expect(refusal).toContain(join(checkout, '.agents', 'skills'))
    expect(refusal).toContain(join(home, 'skills'))
    expect(refusal).toContain(join(home, '.agents', 'skills'))

    // Zero side effects: no event at all, the store holds only the root, nothing spawned, no obligation.
    expect(await storeState(h)).toEqual(before)
    expect(h.spawned).toHaveLength(0)
    expect(before.snapshot.obligations).toEqual([])
    expect(before.snapshot.tasks.map(task => task.taskId)).toEqual([root.taskId])
  })

  it('refuses a provider whose SKILL.md declares another name, before anything is persisted', async () => {
    const directory = await install('verify', { at: 'checkout' })
    // The name is the one thing wrong with this directory: the sidecar is
    // re-pointed at the rewritten bytes, so every content digest in it agrees
    // with what stands there. A worker granted "verify" could not load it —
    // `readSkillFile` publishes a body only under the name it declares — so the
    // batch is refused before the first write instead of at the spawn.
    const file = join(directory, 'SKILL.md')
    const rewritten = (await readFile(file, 'utf8')).replace(/^name:.*$/m, 'name: not-verify')
    await writeFile(file, rewritten)
    await patchSidecar(directory, sidecar => {
      ;(sidecar.content as { skillMdSha256: string }).skillMdSha256 = createHash('sha256').update(rewritten, 'utf8').digest('hex')
    })
    const h = await harness()
    const root = await createRoot(h)
    const before = await storeState(h)

    const refusal = await refusalOf(h, root, [child('verify the ball', ['verify-ball-functional'])])

    expect(refusal).toContain('skill-name-mismatch')
    expect(refusal).toContain('declares name "not-verify" but the capability grants "verify"')
    // Zero side effects: no event, no child, nothing spawned.
    expect(await storeState(h)).toEqual(before)
    expect(h.spawned).toHaveLength(0)
  })

  it('refuses an execution provider whose verifier is not registered, listing the registered ids', async () => {
    const directory = await install('verify', { at: 'checkout' })
    await patchSidecar(directory, sidecar => { sidecar.verifier = { ref: 'no-such-verifier' } })
    const h = await harness()
    const root = await createRoot(h)
    const before = await storeState(h)

    const refusal = await refusalOf(h, root, [child('verify the ball', ['verify-ball-functional'])])

    expect(refusal).toContain('capability "verify-ball-functional"')
    expect(refusal).toContain('verifier-unknown')
    expect(refusal).toContain('"no-such-verifier"')
    expect(refusal).toContain('registered verifiers: command, composite, review')
    expect(await storeState(h)).toEqual(before)
    expect(h.spawned).toHaveLength(0)
  })

  it('refuses a provider whose required tools its capability does not grant', async () => {
    await install('verify', { at: 'checkout' })
    // The same row without the tool labels and the MCP server the sidecar needs.
    const h = await harness({ capabilities: { 'verify-ball-functional': { skills: ['verify'], preset: 'bb-verify' } } })
    const root = await createRoot(h)
    const before = await storeState(h)

    const refusal = await refusalOf(h, root, [child('verify the ball', ['verify-ball-functional'])])

    expect(refusal).toContain('tool-not-covered')
    expect(refusal).toContain('"mcp__bbdev__bbdev_bemu_sim"')
    expect(refusal).toContain('"bash"')
    expect(await storeState(h)).toEqual(before)
    expect(h.spawned).toHaveLength(0)
  })

  it('refuses a provider whose content changed by one byte', async () => {
    const directory = await install('verify', { at: 'checkout' })
    await writeFile(join(directory, 'scripts', 'run_bemu.sh'), `${await readFile(join(directory, 'scripts', 'run_bemu.sh'), 'utf8')}\n`)
    const h = await harness()
    const root = await createRoot(h)
    const before = await storeState(h)

    const refusal = await refusalOf(h, root, [child('verify the ball', ['verify-ball-functional'])])

    expect(refusal).toContain('content-mismatch')
    expect(refusal).toContain('scripts/run_bemu.sh')
    expect(await storeState(h)).toEqual(before)
    expect(h.spawned).toHaveLength(0)
  })

  it('refuses a provider holding a resource shape the contract does not support', async () => {
    const directory = await install('verify', { at: 'checkout' })
    const resource = join(directory, 'scripts', 'run_bemu.sh')
    await rm(resource)
    await symlink(join(directory, 'SKILL.md'), resource)
    const h = await harness()
    const root = await createRoot(h)
    const before = await storeState(h)

    const refusal = await refusalOf(h, root, [child('verify the ball', ['verify-ball-functional'])])

    expect(refusal).toContain('content-unsupported')
    expect(refusal).toContain('scripts/run_bemu.sh')
    expect(refusal).toContain('symbolic link')
    expect(await storeState(h)).toEqual(before)
    expect(h.spawned).toHaveLength(0)
  })

  it('refuses an execution provider when the registry reports no verifier at all, and when it cannot answer', async () => {
    await install('verify', { at: 'checkout' })
    const h = await harness()
    const root = await createRoot(h)
    const before = await storeState(h)

    // The registry answers, with nothing: the phase-1 rule refuses the ref and
    // names the vocabulary it checked against.
    const empty = vi.spyOn(h.verifier, 'verifierIds').mockReturnValue([])
    const refusedOnEmpty = await refusalOf(h, root, [child('verify the ball', ['verify-ball-functional'])])
    expect(refusedOnEmpty).toContain('verifier-unknown')
    expect(refusedOnEmpty).toContain('"command"')
    expect(refusedOnEmpty).toContain('registered verifiers: none')
    expect(await storeState(h)).toEqual(before)
    expect(h.spawned).toHaveLength(0)

    // The registry cannot answer at all (its own read throws): the ref cannot be
    // proved registered either, and it is refused rather than assumed valid.
    empty.mockImplementation(() => { throw new Error('the registry is unreachable') })
    const refusedWhenUnavailable = await refusalOf(h, root, [child('verify the ball', ['verify-ball-functional'])])
    expect(refusedWhenUnavailable).toContain('verifier-unknown')
    expect(refusedWhenUnavailable).toContain('cannot be listed')
    expect(refusedWhenUnavailable).not.toContain('the registry is unreachable')
    expect(await storeState(h)).toEqual(before)
    expect(h.spawned).toHaveLength(0)
  })
})

describe('replay provider pre-check (S1-C)', () => {
  /** A terminal champion: a root task whose single child verified, so the root itself verified. */
  async function champion(h: Harness): Promise<{ storeId: string; taskId: string; runId: string }> {
    const root = await createRoot(h)
    const { batchId } = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT_SESSION, {
      reason: 'the champion ran its own child',
      children: [child('champion work', ['execute-task'])],
    })
    await h.runtime.awaitBatch(root.storeId, batchId)
    // The batch end judged nobody (K1 §2): the champion is terminal because its
    // own submission ran its acceptance over the child that verified.
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'the champion hands in its result' })
    expect((await h.task.taskIn(STORE, root.taskId)).status).toBe('verified')
    return root
  }

  it('refuses a replay whose granted skill does not exist, before creating the task or its run', async () => {
    const h = await harness()
    const root = await champion(h)
    const spawnsAfterChampion = h.spawned.length
    const before = await storeState(h)

    // `design-ball` exists as a row but grants `ball-align`, which nothing on
    // disk holds: the case this ticket adds. Refused with the roots named, and
    // nothing persisted — no replay task, no run, no event, no worker.
    const refusal = await h.runtime.replayTask(STORE, root.taskId, {
      lineage: 'evolution-replay:s1c',
      contract: { objective: 'replay under a candidate row', acceptanceCriteria: [], requiredCapabilities: ['design-ball'] },
    }, ROOT_SESSION).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))

    expect(String(refusal)).toContain('provider pre-check rejected replay')
    expect(String(refusal)).toContain('capability "design-ball"')
    expect(String(refusal)).toContain('skill "ball-align"')
    expect(String(refusal)).toContain(join(checkout, '.agents', 'skills'))

    const after = await storeState(h)
    expect(after.snapshot.tasks.map(task => task.taskId)).toEqual(before.snapshot.tasks.map(task => task.taskId))
    expect(after.snapshot.runs.map(run => run.runId)).toEqual(before.snapshot.runs.map(run => run.runId))
    expect(after.events).toEqual(before.events)
    expect(h.spawned).toHaveLength(spawnsAfterChampion)
  })

  it('drives a knowledge capability through a replay too: loadable, and no execution claim', async () => {
    await install('workload-tests', { at: 'checkout' })
    const h = await harness()
    const root = await champion(h)

    const outcome = await h.runtime.replayTask(STORE, root.taskId, {
      lineage: 'evolution-replay:s1c-knowledge',
      spawn: false,
      contract: { objective: 'replay under a knowledge row', acceptanceCriteria: [REPLAY_CRITERION], requiredCapabilities: ['integrate-model'] },
    }, ROOT_SESSION)

    expect(outcome.status).toBe('verified')
  })
})

describe('the pre-check behind the tool plane (S1-C)', () => {
  it('surfaces the same refusal through task_decompose, with no spawn', async () => {
    const h = await harness({ mountAgent: true, capabilities: { 'design-ball': { skills: ['missing-provider-skill'] } } })
    const root = await createRoot(h)
    const tool = h.tools.get('task_decompose')
    if (tool === undefined) throw new Error('the root agent did not register task_decompose')

    const feedback = await tool.execute({
      reason: 'delegate the design',
      children: [{ objective: 'design the ball', acceptanceCriteria: [{ description: 'works', command: 'true' }], requiredCapabilities: ['design-ball'] }],
    }, { agent: { id: ROOT_SESSION }, callId: 'call-1', signal: new AbortController().signal } as never) as string

    expect(feedback.startsWith(TOOL_REJECTION)).toBe(true)
    expect(feedback).toContain('capability "design-ball"')
    expect(feedback).toContain('skill "missing-provider-skill"')
    expect(h.spawned).toHaveLength(0)
    // The root itself was created before the batch; the batch created no child.
    expect(taskEvents(h).filter(event => event.kind === 'TaskCreated' && event.parentTaskId !== undefined)).toEqual([])
  })
})
