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

const TOOLS = ['singularity_propose_task', 'singularity_submit_program', 'singularity_task_status']
const PROPOSAL: Proposal = { taskId: 'task-x', workspace: '/w', criterionId: 'c', phase: 'awaiting-run' }
const STATUS: Status = { phase: 'running', runs: 1, receipt: null }

/** The three services a mounted scope presents, with every registration the face makes. */
function scope(surface: Partial<AgentTaskSurface>) {
  const tools: ToolDefinition[] = []
  const sections: { name: string; order: number; text: string }[] = []
  const disposed: string[] = []
  const effects: (() => void)[] = []
  const calls: ToolRunContext[] = []
  const ctx = {
    singularity: { forCall: (exec: ToolRunContext) => { calls.push(exec); return surface as AgentTaskSurface } },
    tools: { register: (definition: ToolDefinition) => { tools.push(definition); return () => { disposed.push(definition.name) } } },
    systemPrompt: {
      section: (section: { name: string; order: number; text: string }) => { sections.push(section); return () => { disposed.push(section.name) } },
      getSectionOrder: (sectionName: string) => (sectionName === 'TOOL_SUBAGENT' ? 2800 : 0),
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
  it('registers the three tools and one prompt section into the scope it is mounted in', () => {
    const mounted = scope({})
    apply(mounted.ctx)
    expect([mounted.tools.map(tool => tool.name), mounted.sections.map(section => section.name)]).toEqual([TOOLS, ['singularity:policy']])
  })

  it('offers no parameter through which a caller could name itself', () => {
    const mounted = scope({})
    apply(mounted.ctx)
    expect(mounted.tools.map(tool => Object.keys(tool.parameters.properties ?? {}))).toEqual([['goal', 'input'], ['taskId', 'program'], ['taskId']])
  })

  it('binds the surface from the call it received, not from the arguments it was given', async () => {
    const mounted = scope({ propose: async () => PROPOSAL })
    apply(mounted.ctx)
    const exec = execFor(agentFor('agent-7', 'session-9'), 'call-1')
    const answer = await toolNamed(mounted.tools, 'singularity_propose_task').execute({ goal: 'g', input: 'i' }, exec)
    expect([mounted.calls[0], answerOf(answer)]).toEqual([exec, PROPOSAL])
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

  it('tells the model how its program will be run, rather than leaving it to guess', () => {
    const mounted = scope({})
    apply(mounted.ctx)
    const described = toolNamed(mounted.tools, 'singularity_submit_program').description
    expect([/ES module/.test(described), /standard output/.test(described), /standard error/.test(described)]).toEqual([true, true, true])
  })

  it('owns every registration through the effect it opened', () => {
    const mounted = scope({})
    apply(mounted.ctx)
    mounted.dispose()
    expect(mounted.disposed).toEqual([...TOOLS, 'singularity:policy'])
  })

  it('places its guidance at the order the host owns, naming what it registered', () => {
    const mounted = scope({})
    apply(mounted.ctx)
    const guidance = mounted.sections[0]
    expect([guidance?.order, TOOLS.every(tool => guidance?.text.includes(tool))]).toEqual([2800, true])
  })

  it('declares the services it drives rather than assuming them', () => {
    expect([name, inject]).toEqual(['singularity-agent', ['singularity', 'tools', 'systemPrompt']])
  })
})
