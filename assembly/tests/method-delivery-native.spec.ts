import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it } from 'vitest'
import { hostRequire } from '../../scripts/host-config.mjs'
import { postIdentifiedMessage } from '../../src/runtime/identified-message.ts'
import { schedulerMessage } from '../../src/runtime/task-message.ts'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { openApparatus, taskStateOf, type Apparatus } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import { createMethod } from '../src/method.ts'
import { confirmWorkflowDelivery, methodContext, readMethodContext } from '../src/method-run.ts'
import { spawnProcess } from '../src/process.ts'
import { propose } from '../src/surfaces.ts'
import { attachmentsAt } from './seam.ts'

const nativeRequire = hostRequire()
const { default: SystemPrompt } = await import(nativeRequire.resolve('@deepseek-ai/dsh-system-prompt')) as typeof import('@deepseek-ai/dsh-system-prompt')
const { default: SessionProjections } = await import(nativeRequire.resolve('@deepseek-ai/dsh-session-projection')) as typeof import('@deepseek-ai/dsh-session-projection')
const roots: string[] = [], contexts: Context[] = [], apparatuses: Apparatus[] = []
afterEach(async () => {
  for (const apparatus of apparatuses.splice(0)) await apparatus.store.close()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class DeliveryAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  requestRead = false
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (this.requestRead) {
      this.requestRead = false
      const id = ToolCallId('native-method-read')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'read_pinned_method', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read_pinned_method', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Observed the assigned packet.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Observed the assigned packet.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('durably delivers the exact workflow on the first native step and records a later native tool read separately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'method-delivery-native-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new DeliveryAdapter()
  ctx.llm.registerAdapter(['delivery-fixture'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('native-method-recipient'), { provider: 'delivery-fixture', model: 'fixture', maxTokens: 128 })
  const domain = await loadDomain(fileURLToPath(new URL('../../domain/reference', import.meta.url)), spawnProcess)
  const apparatus = await openApparatus('native-delivery', root, domain, ctx.sessionPersistence, attachmentsAt(root), ctx.sessionProjections)
  apparatuses.push(apparatus)
  const workflowGuidance = 'Investigate the uncertain interface before choosing independent responsibility boundaries.'
  const method = await createMethod(apparatus, { workflowGuidance, templates: [], skills: [], tools: [] })
  const contract = { goal: 'Return an independently checked result.', artifact: 'result.txt', inputs: [], criteria: [{ criterionId: 'result', statement: 'Return the required result.' }] }
  const task = await propose(apparatus, { agentId: String(agent.id), sessionId: String(agent.session.id), model: { provider: 'delivery-fixture', model: 'fixture' } },
    'native-dispatch', { contract, method })
  const run = taskStateOf(apparatus, task.taskId).runs[task.runId]!
  const modes = () => taskStateOf(apparatus, task.taskId).runs[run.runId]!.consumed.map(use => use.mode)
  const packet = await methodContext(apparatus, task.taskId, run)
  expect(await confirmWorkflowDelivery(apparatus, task.taskId, run)).toBe(false)
  expect(modes()).toEqual([])
  const firstStepModes: string[][] = []
  ctx.on('agent/pre-step', async (event, next) => {
    if (event.agent === agent) {
      expect(await confirmWorkflowDelivery(apparatus, task.taskId, run)).toBe(true)
      firstStepModes.push(modes())
    }
    return next()
  })
  ctx.tools.register(defineTool({ name: 'read_pinned_method', description: 'Read the pinned workflow explicitly.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => JSON.stringify(await readMethodContext(apparatus, task.taskId, run)),
  }))
  const dispatch = schedulerMessage({ kind: 'singularity', purpose: 'dispatch', controlId: apparatus.controlId,
    parentTaskId: task.taskId, taskId: task.taskId, runId: run.runId, factSeq: 0 }, JSON.stringify({ contract, method: packet }))
  expect(await postIdentifiedMessage(ctx as unknown as ChildSessionSeams, agent, dispatch)).toBe('posted')
  await agent.whenIdle()
  expect(await ctx.sessions.flush(agent.session)).toBe(true)
  expect(firstStepModes[0]).toEqual(['delivered'])
  expect(adapter.calls).toHaveLength(1)
  expect(JSON.stringify(adapter.calls[0]!.messages)).toContain(workflowGuidance)
  expect(modes()).toEqual(['delivered'])
  const persisted = await ctx.sessionPersistence.open(agent.session.id, 'read')
  try {
    const events = (await persisted.read()).events
    expect(events.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted)).toEqual([dispatch])
    expect(events.filter(event => event.type === 'user/message').map(event => event.data)).toEqual([dispatch])
  } finally { await persisted.close() }
  expect(await postIdentifiedMessage(ctx as unknown as ChildSessionSeams, agent, dispatch)).toBe('entered')
  expect(adapter.calls).toHaveLength(1)
  adapter.requestRead = true
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the pinned method through the provided tool.' }] }))
  await agent.whenIdle()
  expect(modes()).toEqual(['delivered', 'read'])
  expect(adapter.calls).toHaveLength(3)
  expect(taskStateOf(apparatus, task.taskId).contract).toEqual(contract)
})
