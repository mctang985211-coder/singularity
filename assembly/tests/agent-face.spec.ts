/**
 * The agent face: exactly what a model can call, and what it cannot claim.
 *
 * The scope below is the seam a preset mounts the face into — the host's service, the tool registry
 * and the prompt — so these cases read the registrations the model would actually see.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import { ProtocolRefusal } from '../../src/protocol/refusal.ts'
import { apply, inject, name } from '../src/agent.ts'
import type { AgentTaskSurface, Proposal, Status } from '../src/driver.ts'
import { agentFor, execFor } from './seam.ts'

const TOOLS = ['singularity_retry_task', 'singularity_decompose_task', 'singularity_submit_program', 'singularity_task_status', 'singularity_create_method', 'singularity_run_method', 'singularity_evolve_method', 'singularity_method_history']
type PromptSection = Parameters<Context['systemPrompt']['section']>[0]
const PROPOSAL: Proposal = { taskId: 'task-x', runId: 'run-x', workspace: '/w', criterionId: 'c', phase: 'running', submission: 'program', input: 'in/data', artifact: 'out',
  inputContent: 'actual input', initialSource: null, rootTemplate: 'root', templates: [],
  methodContext: { method: { environmentId: 'methods', revisionId: 'method', digest: 'digest' },
    template: { id: 'root', digest: 'digest' }, guidance: 'guide', bindings: { skills: [], tools: [], gaps: [] },
    boundSkills: [], references: [], localCheck: [] } }
const STATUS: Status = { phase: 'running', runs: 1, receipt: null, task: {
  taskId: 'task-x', goal: 'g', contractDigest: 'digest', admittedBy: 'scheduler', admittedAt: 'now', phase: 'running', criteria: [], runs: [],
  contract: { goal: 'g', template: { id: 'root', digest: 'digest' }, inputs: [], criteria: [] }, agentId: 'a', sessionId: 's', decomposition: null,
} }

/** The services a mounted scope presents, with every registration the face makes. */
function scope(surface: Partial<AgentTaskSurface>, purpose: (agentId: string) => string = () => 'solve') {
  const tools: ToolDefinition[] = []
  const sections: PromptSection[] = []
  const disposed: string[] = []
  const effects: (() => void)[] = []
  const calls: ToolRunContext[] = []
  const ctx = {
    singularity: { purpose, forCall: (exec: ToolRunContext) => { calls.push(exec); return surface as AgentTaskSurface } },
    tools: { register: (definition: ToolDefinition) => { tools.push(definition); return () => { disposed.push(definition.name) } } },
    systemPrompt: {
      section: (section: PromptSection) => { sections.push(section); return () => { disposed.push(section.name) } },
    },
    effect: (body: () => () => void) => { effects.push(body()) },
  }
  return { ctx: ctx as unknown as Context, tools, sections, disposed, calls, dispose: () => { for (const effect of effects) effect() } }
}

const toolNamed = (tools: readonly ToolDefinition[], wanted: string): ToolDefinition => {
  const found = tools.find(entry => entry.name === wanted)
  if (found === undefined) throw new Error(`the face registered no tool ${wanted}`)
  return found
}

const answerOf = (value: unknown): unknown => JSON.parse(String(value))

describe('the agent face', () => {
  it('registers task and Method tools and one prompt section into the scope it is mounted in', () => {
    const mounted = scope({})
    apply(mounted.ctx)
    expect([mounted.tools.map(tool => tool.name), mounted.sections.map(section => section.name)]).toEqual([TOOLS, ['singularity:protocol']])
  })

  it('offers no parameter through which a caller could name itself', () => {
    const mounted = scope({})
    apply(mounted.ctx)
    expect(mounted.tools.map(tool => Object.keys(tool.parameters.properties ?? {}))).toEqual([['taskId'], ['plan'], ['taskId', 'program'], ['taskId'], ['path'], ['taskId', 'tool', 'candidate'], ['round'], []])
  })

  it('isolates the review tool catalog and prompt even when the parent is a solver', () => {
    const mounted = scope({}, () => 'solve')
    apply(mounted.ctx, { role: 'review' })
    expect(mounted.tools.map(tool => tool.name)).toEqual([
      'singularity_retry_task', 'singularity_submit_program', 'singularity_task_status', 'singularity_method_history',
    ])
    const provider = mounted.sections[0]!.text as Exclude<PromptSection['text'], string>
    const prompt = provider({ agent: agentFor('reviewer', 'reviewer') })
    expect(prompt).toContain('Independent review guidance:')
    expect(prompt).toContain('Never invent ablation recipes')
    expect(prompt).not.toContain('{taskId,useTemplateDecomposition:true}')
    expect(prompt).not.toContain('Write the complete Revision JSON')
    mounted.dispose()
    expect(mounted.disposed).toHaveLength(5)
  })

  it('selects responsibilities from the assembling agent on every request without inheriting parent exploration guidance', () => {
    const purposes = new Map([['root', 'solve'], ['reviewer', 'review'], ['improver', 'improve']])
    const mounted = scope({}, id => purposes.get(id)!)
    apply(mounted.ctx)
    const provider = mounted.sections[0]!.text as Exclude<PromptSection['text'], string>
    const prompt = (id: string) => provider({ agent: agentFor(id, id) })
    expect(prompt('root')).toContain('make a concrete decomposition call before the next batch')
    expect(prompt('reviewer')).toContain('Independent review guidance')
    expect(prompt('reviewer')).not.toContain('make a concrete decomposition call before the next batch')
    expect(prompt('improver')).toContain('Start with the frozen structural summary')
    expect(prompt('reviewer')).not.toContain('Start with the frozen structural summary')
    purposes.set('root', 'review')
    expect(prompt('root')).toBe(prompt('reviewer'))
    expect(mounted.tools.map(tool => tool.name)).toEqual(TOOLS)
  })

  it('binds the surface from the call it received, not from the arguments it was given', async () => {
    const mounted = scope({ retry: async () => PROPOSAL })
    apply(mounted.ctx)
    const exec = execFor(agentFor('agent-7', 'session-9'), 'call-1')
    const answer = await toolNamed(mounted.tools, 'singularity_retry_task').execute({ taskId: 'task-x' }, exec)
    expect([mounted.calls[0], answerOf(answer)]).toEqual([exec, PROPOSAL])
  })

  it('submits the agent-authored Revision file through the owned Run port', async () => {
    let received: unknown
    const revision = { environmentId: 'methods', revisionId: 'candidate', digest: 'a'.repeat(64) }
    const mounted = scope({ createMethod: async input => { received = input; return revision } })
    apply(mounted.ctx)
    const answer = await toolNamed(mounted.tools, 'singularity_create_method').execute({ path: 'work/revision.json' }, execFor(agentFor('a', 's'), 'freeze'))
    expect(received).toEqual({ path: 'work/revision.json' })
    expect(answerOf(answer)).toEqual(revision)
  })

  it('selects a host template and preserves the dependency plan without a model goal', async () => {
    const children = [{ key: 'extract', template: 'extract-letters', dependsOn: [], supports: ['letters'], maxRuns: 1 }]
    let received: unknown
    const mounted = scope({ decompose: async input => { received = input; return { taskId: input.taskId, opened: [] } } })
    apply(mounted.ctx)
    const tool = toolNamed(mounted.tools, 'singularity_decompose_task')
    await tool.execute({ plan: JSON.stringify({ taskId: 'parent', children }) }, execFor(agentFor('a', 's'), 'plan'))
    expect(received).toEqual({ taskId: 'parent', children })
  })

  it('accepts the template decomposition through the serialized plan argument', async () => {
    let received: unknown
    const mounted = scope({ decompose: async input => { received = input; return { taskId: input.taskId, opened: [] } } })
    apply(mounted.ctx)
    const tool = toolNamed(mounted.tools, 'singularity_decompose_task')
    await tool.execute({ plan: JSON.stringify({ taskId: 'parent', useTemplateDecomposition: true }) }, execFor(agentFor('a', 's'), 'recipe'))
    expect(received).toEqual({ taskId: 'parent', useTemplateDecomposition: true })
  })

  it('returns a domain refusal as the answer the model reads', async () => {
    const mounted = scope({ submit: async () => { throw new ProtocolRefusal({ code: 'not-responsible', detail: 'nope' }) } })
    apply(mounted.ctx)
    const answer = await toolNamed(mounted.tools, 'singularity_submit_program').execute({ taskId: 't', program: 'p' }, execFor(agentFor('agent-7', 'session-9'), 'call-1'))
    expect(answerOf(answer)).toEqual({ refused: 'not-responsible', detail: 'nope' })
  })

  it('propagates a failure that is not a refusal, instead of dressing it as an answer', async () => {
    const mounted = scope({ status: async () => { throw new Error('the store is gone') } })
    apply(mounted.ctx)
    await expect(toolNamed(mounted.tools, 'singularity_task_status').execute({ taskId: 't' }, execFor(agentFor('agent-7', 'session-9'), 'call-1'))).rejects.toThrow('the store is gone')
  })

  it('determines the model-facing text of a reading', async () => {
    const mounted = scope({ status: async () => STATUS })
    apply(mounted.ctx)
    const answer = await toolNamed(mounted.tools, 'singularity_task_status').execute({ taskId: 't' }, execFor(agentFor('agent-7', 'session-9'), 'call-1'))
    expect(answerOf(answer)).toEqual(STATUS)
  })

  it('awaits sealed task and Method history before rendering the one public read port', async () => {
    const history = { tasks: [STATUS.task], methods: [], decisions: [] }
    const mounted = scope({ history: async () => history })
    apply(mounted.ctx)
    expect(answerOf(await toolNamed(mounted.tools, 'singularity_method_history').execute({}, execFor(agentFor('a', 's'), 'history')))).toEqual(history)
  })

  it('owns every registration through the effect it opened', () => {
    const mounted = scope({})
    apply(mounted.ctx)
    mounted.dispose()
    expect(mounted.disposed).toEqual([...TOOLS, 'singularity:protocol'])
  })

  it('declares the services it drives rather than assuming them', () => {
    expect([name, inject]).toEqual(['singularity-agent', ['singularity', 'tools', 'systemPrompt']])
  })
})
