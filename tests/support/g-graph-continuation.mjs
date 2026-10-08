/** Independent process fixture. Every runtime import is the deployment's built lib. */
import assert from 'node:assert/strict'
import { copyFileSync, appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Service } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import LlmRuntime, {
  LlmAdapter,
  createUserMessage,
} from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import SkillRegistry from '../../../../thirdparty/deepseek-harness/packages/skill/skill/lib/index.js'
import SessionStore, { SessionId } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import SessionProjectionRegistry from '../../../../thirdparty/deepseek-harness/packages/session/session-projection/lib/index.js'
import SystemPrompt from '../../../../thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../../thirdparty/deepseek-harness/packages/core/tools/lib/index.js'
import { AgentRegistry } from '../../../../thirdparty/deepseek-harness/packages/core/agent/lib/index.js'
import AgentLoop from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/lib/index.js'
import JsonlSessionPersistence from '../../../../thirdparty/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import SessionQueryEngine from '../../../../thirdparty/deepseek-harness/packages/session-query/session-query/lib/index.js'
import { EnvStore } from '../../../env-builder/lib/index.js'
import { GraphService } from '../../graph/lib/index.js'
import { LayoutService } from '../../graph/lib/layout.js'
import { GraphsService } from '../../graphs/lib/index.js'
import { AgentRuntime } from '../../agent-runtime/lib/index.js'
import { TaskService, rootTaskStoreId } from '../../task/lib/index.js'
import { TaskRuntime } from '../../task-runtime/lib/index.js'
import { VerifierRegistry } from '../../verifier/lib/index.js'
import { SingularityContextService } from '../../context/lib/index.js'
import SingularityAgent from '../../agent-singularity/lib/index.js'

const [mode, directory, boundary = 'active', entry = 'automatic'] = process.argv.slice(2)
assert.ok(directory)
const realNow = Date.now
Date.now = () => realNow() + Number(process.env.G_CONTINUE_CLOCK_ADVANCE_MS ?? 0)
process.env.DSH_HOME = join(directory, 'home')
mkdirSync(join(process.env.DSH_HOME, 'skills', 'task-execution'), { recursive: true })
copyFileSync(new URL('../../agent-runtime/skills/task-execution/SKILL.md', import.meta.url), join(process.env.DSH_HOME, 'skills', 'task-execution', 'SKILL.md'))
/** The graph's round-1 bubble: the directory its agents work in and its verifiers run criteria in. */
function graphWorkspace(graph) {
  return join(process.env.DSH_HOME, 'singularity', 'environments', graph.rootSessionId, 'bubbles', 'round-1', 'workspace')
}
const ctx = new Context()
const requests = []
const calls = []
const selected = []
let graph
let runtime
let callSequence = 0
let verifierEntered = false
const crash = mode === 'crash'
const finish = mode === 'continue' || mode === 'retry' || mode === 'retry-wake'
const goal = 'deliver the release artifact'
const criterion = { description: 'release artifact is delivered', command: 'test "$(cat release.txt)" = delivered' }
const markerFile = join(directory, 'death.json')
const reportFile = join(directory, 'report.json')
const previous = existsSync(markerFile) ? JSON.parse(readFileSync(markerFile, 'utf8')) : undefined

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolChunks(name, args) {
  const id = `g-${process.pid}-${++callSequence}`
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function waitAborted(signal) {
  return new Promise((_, reject) => {
    const stop = () => reject(new Error('fixture provider request aborted'))
    if (signal?.aborted) stop()
    else signal?.addEventListener('abort', stop, { once: true })
  })
}

class FrozenProvider extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(options) {
    const sessionId = String(options.sessionId)
    requests.push({ sessionId, messages: options.messages, tools: options.tools })
    const snapshot = graph === undefined ? undefined : await ctx.task.snapshotIn(rootTaskStoreId(graph.rootSessionId))
    const run = snapshot?.runs.find(item => item.sessionId === sessionId)
    let response
    if (run === undefined) {
      const userGoal = options.messages.some(message =>
        message.content.some(block => block.type === 'text' && block.text === goal),
      )
      response = userGoal
        ? toolChunks('task_intake', { objective: goal, requiredCapabilities: ['execute-task'], acceptanceCriteria: [criterion] })
        : textChunks('environment ready')
    } else if (run.status !== 'running') {
      response = textChunks('result accepted')
    } else {
      const task = snapshot.tasks.find(item => item.taskId === run.taskId)
      const questions = snapshot.questions?.all ?? []
      const unresolved = questions.find(
        question => question.parentRunId === run.runId && !question.answers?.some(answer => answer.resolves),
      )
      const blocked = questions.some(
        question =>
          question.childRunId === run.runId && question.blocking && !question.answers?.some(answer => answer.resolves),
      )
      if (blocked && finish) {
        response = textChunks('waiting for the original parent answer')
      } else if (unresolved !== undefined && finish) {
        response = toolChunks('task_answer', {
          questionId: unresolved.questionId,
          requestKey: 'release-contract-answer',
          answer: 'Deliver the original release artifact.',
          resolves: true,
        })
      } else if (unresolved !== undefined && crash) {
        await waitAborted(options.signal)
        return
      } else if (run.executionPhase === 'waiting_children' || run.executionPhase === 'submitted') {
        response = textChunks('waiting for the current batch')
      } else if (task.objective === goal && task.childTaskIds.length === 0) {
        response = toolChunks('task_decompose', {
          reason: 'Prepare the independent release evidence and the release artifact.',
          requestKey: 'release-parts',
          children: [
            {
              objective: 'prepare release evidence', requiredCapabilities: ['execute-task'],
              acceptanceCriteria: [{ description: 'evidence is written', command: 'test -f sibling.txt' }],
            },
            { objective: 'coordinate release artifact', requiredCapabilities: ['execute-task'], acceptanceCriteria: [criterion] },
          ],
        })
      } else if (task.objective === 'coordinate release artifact' && task.childTaskIds.length === 0) {
        response = toolChunks('task_decompose', {
          reason: 'The artifact has a distinct verifiable result.',
          requestKey: 'release-artifact',
          children: [{ objective: 'write release artifact', requiredCapabilities: ['execute-task'], acceptanceCriteria: [criterion] }],
        })
      } else if (
        task.objective === 'prepare release evidence' &&
        !existsSync(join(graphWorkspace(graph), 'sibling.txt'))
      ) {
        response = toolChunks('write', { path: 'sibling.txt', content: 'evidence' })
      } else if (task.objective === 'write release artifact' && crash && boundary === 'active') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'working on the original artifact' }
        await waitAborted(options.signal)
        return
      } else if (
        task.objective === 'write release artifact' &&
        crash &&
        boundary === 'question' &&
        !questions.some(question => question.childRunId === run.runId)
      ) {
        response = toolChunks('task_ask_parent', {
          requestKey: 'release-contract-question',
          question: 'Confirm the original release artifact contract.',
          blocking: true,
        })
      } else if (task.objective === 'write release artifact' && crash && boundary === 'question') {
        await waitAborted(options.signal)
        return
      } else if (
        task.objective === 'write release artifact' &&
        !existsSync(join(graphWorkspace(graph), 'release.txt'))
      ) {
        response = toolChunks('write', { path: 'release.txt', content: 'delivered' })
      } else if (
        task.objective === 'write release artifact' &&
        finish &&
        boundary === 'missing-receipt' &&
        !calls.some(call => call.sessionId === sessionId && call.name === 'read')
      ) {
        response = toolChunks('read', { path: 'release.txt' })
      } else {
        response = toolChunks('task_submit_result', { summary: `${task.objective} delivered` })
      }
    }
    yield* response
  }
}

class ExactSessionQuery extends SessionQueryEngine {
  searchSessions() {
    throw new Error('this fixture performs exact persisted Session reads')
  }
  searchEvents() {
    throw new Error('this fixture performs exact persisted event reads')
  }
}

await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(SkillRegistry, {})
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
new JsonlSessionPersistence(ctx, { root: join(directory, 'sessions'), compression: 'none' })
await ctx.plugin(ExactSessionQuery)
ctx.effect(() => ctx.llm.registerAdapter(['g-fixture'], new FrozenProvider()))
ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'g-fixture', model: 'frozen' }) })
ctx.provide('agentPresets', { defaultId: 'standard', mount: async () => {}, resolve: async () => ({}) })
ctx.provide('permissionPresets', { set: () => {}, resolve: () => ({}) })
ctx.provide('approval', { request: async () => 'allowed-once' })
ctx.provide('userQuestions', { ask: async () => ({ answers: [] }) })
ctx.provide('envBuilder', { store: new EnvStore(join(directory, 'environments')) })
new GraphService(ctx)
new LayoutService(ctx)
new AgentRuntime(ctx)
if (mode === 'retry-wake') {
  const resume = ctx.agentRuntime.resumeWorkerAgent.bind(ctx.agentRuntime)
  let failWake = true
  ctx.agentRuntime.resumeWorkerAgent = async (...args) => {
    const handle = await resume(...args)
    if (String(handle.agent.id) === previous.snapshot.runs.find(run => run.executionPhase === 'active').sessionId) {
      const followup = handle.agent.followup.bind(handle.agent)
      handle.agent.followup = message => {
        if (failWake) {
          failWake = false
          throw new Error('fixture: original worker continuation wake failed')
        }
        return followup(message)
      }
    }
    return handle
  }
}
new TaskService(ctx)
const verifier = new VerifierRegistry(ctx, { evidenceRoot: join(directory, 'evidence') })
await verifier.ready()
runtime = new TaskRuntime(ctx, { capabilities: { 'execute-task': { skills: ['task-execution'] } }, runBindingRoot: join(directory, 'bindings') })
await runtime[Service.init]()
await ctx.plugin(AgentLoop, { agents: [] })
const graphs = new GraphsService(ctx)
const singularityContext = new SingularityContextService(ctx)
singularityContext[Service.init]()
// No coordination supervisor runs in this fixture: the spec's subject is the
// graph's own continuation topology, and the platform RSI loop only touches a
// graph that declares `rsi` settings (this one does not).
const singularity = new SingularityAgent(ctx, { methodTools: 'off' })
await singularity[Service.init]()
// The rest of the root's core tool plane (`agent-runtime`'s `ROOT_CORE_TOOLS`):
// a real bundle mounts these, and the root's own `tools.restrict` is fail-closed
// on a declared name the composition does not offer. This fixture's model never
// calls them, so they stand in for the composition's shape.
for (const name of ['glob', 'grep', 'edit', 'bash', 'job_list', 'job_output', 'job_kill']) {
  ctx.tools.register({
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => `${name}: fixture answer`,
  })
}
ctx.tools.register({
  name: 'skill',
  description: 'Read the task execution method selected by this Task.',
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: async () => readFileSync(join(process.env.DSH_HOME, 'skills', 'task-execution', 'SKILL.md'), 'utf8'),
})
ctx.tools.register({
  name: 'read',
  description: 'Read an artifact to check an interrupted local write.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: async args => readFileSync(join(graphWorkspace(graph), args.path), 'utf8'),
})
ctx.tools.register({
  name: 'write',
  description: 'Write the release fixture artifact.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: async (args, exec) => {
    const cwd = graphWorkspace(graph)
    writeFileSync(join(cwd, args.path), args.content)
    appendFileSync(
      join(directory, 'effects.jsonl'),
      `${JSON.stringify({ sessionId: exec.agent.id, path: args.path })}\n`,
    )
    if (crash && boundary === 'missing-receipt' && args.path === 'release.txt') await waitAborted(exec.signal)
    return `wrote ${args.path}`
  },
})
ctx.on('graphs/selected', record => {
  selected.push(record.id)
})
ctx.on('tools/pre-execute', (exec, next) => {
  calls.push({ sessionId: exec.agent?.id, callId: exec.callId, name: exec.name, args: exec.arguments })
  return next()
})
ctx.on('tools/result', (exec, result) => {
  const call = calls.find(item => item.callId === exec.callId)
  if (call) call.result = result
})
if (crash && boundary === 'submitted') {
  const verify = verifier.verifyRun.bind(verifier)
  verifier.verifyRun = async (storeId, runId, options) => {
    const run = await ctx.task.runIn(storeId, runId)
    const task = await ctx.task.taskIn(storeId, run.taskId)
    if (task.objective === 'write release artifact') {
      verifierEntered = true
      await new Promise(() => {})
    }
    return verify(storeId, runId, options)
  }
}

async function until(read, explanation) {
  const started = performance.now()
  while (!(await read())) {
    if (performance.now() - started > 20_000) {
      writeFileSync(
        reportFile,
        JSON.stringify({
          requests: requests.slice(-5),
          calls: calls.slice(-5),
          selected,
          snapshot: await ctx.task.snapshotIn(rootTaskStoreId(graph.rootSessionId)),
          recovery: [...runtime.storeRecovery],
        }),
      )
      throw new Error(
        `fixture did not reach ${explanation}; recovery=${JSON.stringify([...runtime.storeRecovery])}; requests=${JSON.stringify(requests.map(request => request.sessionId))}; calls=${JSON.stringify(calls.slice(-5))}`,
      )
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function durableReport() {
  for (const session of ctx.sessions.list()) await ctx.sessions.flush(session)
  const storeId = rootTaskStoreId(graph.rootSessionId)
  const snapshot = await ctx.task.snapshotIn(storeId)
  const sessions = {}
  for (const run of snapshot.runs) {
    const handle = await ctx.sessionPersistence.open(SessionId(run.sessionId), 'read')
    sessions[run.sessionId] = await handle.read()
    await handle.close()
  }
  return {
    pid: process.pid,
    boundary,
    graph,
    topology: await ctx.graph.snapshotIn(graph.graphStoreId),
    storeId,
    snapshot,
    sessions,
    requests,
    calls,
    selected,
    live: ctx.agents.list().map(agent => agent.id),
    config: runtime.config,
  }
}

if (crash) {
  graph = (await graphs.create({ createEnv: true, repos: ['fixture/release'] })).graph
  const root = ctx.agents.get(graph.rootSessionId)
  await root.whenIdle()
  root.followup(createUserMessage({ content: [{ type: 'text', text: goal }], source: { kind: 'user' } }))
  await until(async () => {
    const snapshot = await ctx.task.snapshotIn(rootTaskStoreId(graph.rootSessionId))
    const leaf = snapshot.tasks.find(task => task.objective === 'write release artifact')
    const run = leaf && snapshot.runs.find(item => item.taskId === leaf.taskId)
    if (!run) return false
    if (boundary === 'question') return (snapshot.questions?.all ?? []).length === 1
    if (boundary === 'submitted') return run.executionPhase === 'submitted' && verifierEntered
    if (boundary === 'missing-receipt')
      return existsSync(join(graphWorkspace(graph), 'release.txt'))
    return run.executionPhase === 'active' && requests.some(request => request.sessionId === run.sessionId)
  }, boundary)
  if (entry === 'button') {
    await until(
      async () => (await ctx.task.snapshotIn(rootTaskStoreId(graph.rootSessionId))).runs.length === 4,
      'all original runs',
    )
    const other = await graphs.create({ createEnv: true, repos: ['fixture/other'] })
    await ctx.agents.get(other.graph.rootSessionId).whenIdle()
    assert.equal((await graphs.current()).id, other.graph.id)
  }
  writeFileSync(markerFile, JSON.stringify(await durableReport()))
  process.kill(process.pid, 'SIGKILL')
  throw new Error('SIGKILL did not terminate the writer')
} else {
  graph = previous.graph
  if (entry === 'button') {
    await until(() => selected.length > 0, 'unrelated selected graph automatic activation')
    assert.equal(
      requests.filter(request => previous.snapshot.runs.some(run => run.sessionId === request.sessionId)).length,
      0,
    )
  }
  if (mode === 'refuse' || mode === 'retry' || mode === 'retry-wake') {
    let failure
    try {
      await graphs.select(graph.id)
    } catch (error) {
      failure = { name: error.name, message: error.message }
    }
    assert.ok(failure, 'the persisted fault must reject select')
    if (mode === 'retry' || mode === 'retry-wake') {
      assert.equal(requests.length, 0, 'failed activation must wake no model')
      if (mode === 'retry') {
        const repair = JSON.parse(readFileSync(join(directory, 'repair.json'), 'utf8'))
        writeFileSync(repair.path, repair.contents)
      }
      await Promise.all([graphs.select(graph.id), graphs.select(graph.id)])
      await until(
        async () => (await ctx.task.snapshotIn(previous.storeId)).runs.every(run => run.status === 'verified'),
        'same-process explicit activation retry',
      )
      writeFileSync(reportFile, JSON.stringify({ ...(await durableReport()), failure }))
    } else {
      writeFileSync(
        reportFile,
        JSON.stringify({
          pid: process.pid,
          failure,
          requests,
          topology: await ctx.graph.snapshotIn(graph.graphStoreId),
          sessions: (await ctx.sessionPersistence.list()).map(item => item.header.id),
        }),
      )
    }
  } else {
    if (entry === 'automatic') await until(() => selected.includes(graph.id), 'automatic selected graph activation')
    const automatic = { selected: [...selected], requests: requests.map(request => request.sessionId) }
    await Promise.all([graphs.select(graph.id), graphs.select(graph.id), graphs.select(graph.id)])
    await until(
      async () => (await ctx.task.snapshotIn(previous.storeId)).runs.every(run => run.status === 'verified'),
      'all original final acceptance verdicts',
    )
    writeFileSync(reportFile, JSON.stringify({ ...(await durableReport()), automatic }))
  }
  // These are short-lived independent test images; unloading a parked verifier
  // is intentionally outside this fixture. Process exit closes all real locks.
  process.exit(0)
}
