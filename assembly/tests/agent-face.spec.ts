import type { Context } from '@deepseek-ai/cordis'
import { ToolArgsError, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import { apply } from '../src/agent.ts'
import { guidanceFor } from '../src/prompts.ts'
import type { AgentTaskSurface } from '../src/task-service.ts'
import { agentFor, execFor } from './seam.ts'
function scope(surface: Partial<AgentTaskSurface> = {}) {
  const tools: ToolDefinition[] = [],
    effects: (() => void)[] = [],
    disposed: string[] = [],
    prompts: { name: string; order: number; text: string }[] = []
  const ctx = {
    provide: () => undefined,
    on: () => () => disposed.push('listener'),
    singularity: { forCall: () => ({ current: () => 'host-task', ...surface }) },
    tools: {
      register: (tool: ToolDefinition) => {
        tools.push(tool)
        return () => disposed.push(tool.name)
      },
    },
    systemPrompt: {
      section: (prompt: (typeof prompts)[number]) => {
        prompts.push(prompt)
        return () => disposed.push('prompt')
      },
    },
    effect: (f: () => () => void) => effects.push(f()),
  } as unknown as Context
  return { ctx, tools, prompts, dispose: () => effects.forEach(f => f()), disposed }
}
describe('small role interfaces', () => {
  it.each([
    [
      'root',
      [
        'singularity_read',
        'singularity_memory',
        'singularity_submit',
        'singularity_decompose_task',
        'singularity_stop_explorations',
        'singularity_answer',
        'singularity_retry_task',
      ],
    ],
    [
      'task',
      [
        'singularity_read',
        'singularity_memory',
        'singularity_submit',
        'singularity_stop_explorations',
        'singularity_decompose_task',
        'singularity_ask_parent',
        'singularity_answer',
        'singularity_retry_task',
        'singularity_run_method',
      ],
    ],
    [
      'review',
      [
        'singularity_read',
        'singularity_memory',
        'singularity_submit',
        'singularity_decompose_task',
        'singularity_answer',
      ],
    ],
    ['improve', ['singularity_read', 'singularity_memory', 'singularity_submit', 'singularity_propose_method']],
  ] as const)('mounts only %s operations', (role, names) => {
    const s = scope()
    apply(s.ctx, { role })
    expect(s.tools.map(t => t.name)).toEqual(names)
    const kinds = (
      s.tools.find(t => t.name === 'singularity_read')!.parameters.properties as {
        kind: { enum: readonly string[] }
      }
    ).kind.enum
    expect(kinds).toContain('method')
    expect(kinds.includes('roots')).toBe(role === 'improve')
    expect(
      Object.hasOwn(s.tools.find(tool => tool.name === 'singularity_read')!.parameters.properties!, 'rootId'),
    ).toBe(role === 'improve' || role === 'review')
    if (role === 'task' || role === 'root') expect(kinds).not.toContain('round')
    for (const tool of s.tools) {
      const keys = Object.keys(tool.parameters.properties ?? {})
      expect(keys).not.toContain('taskId')
      expect(keys).not.toContain('agentId')
      expect(keys).not.toContain('program')
    }
    s.dispose()
    expect(s.disposed).toHaveLength(names.length + 2)
  })
  it.each(['root', 'task', 'review', 'improve'] as const)(
    'keeps the %s system policy fixed across Task state changes',
    async role => {
      let state = { taskId: 'first-task', purpose: 'solve' }
      const s = scope({ current: () => state.taskId, history: async () => state })
      apply(s.ctx, { role })
      expect(s.prompts).toEqual([{ name: 'singularity:protocol', order: 60, text: guidanceFor(role) }])
      const policy = s.prompts[0]!.text
      expect(typeof policy).toBe('string')
      const read = s.tools.find(tool => tool.name === 'singularity_read')!
      const exec = execFor(agentFor('a', 'a'), 'read')
      expect(JSON.parse((await read.execute({ kind: 'summary' }, exec)) as string)).toEqual(state)
      state = { taskId: 'second-task', purpose: 'improve' }
      expect(JSON.parse((await read.execute({ kind: 'summary' }, exec)) as string)).toEqual(state)
      expect(s.prompts[0]!.text).toBe(policy)
    },
  )
  it('binds structured child responsibilities to the actual current owner', async () => {
    let got: unknown
    const s = scope({
      decompose: async input => {
        got = input
        return { taskId: input.taskId, opened: [], next: 'End this turn' }
      },
    })
    apply(s.ctx)
    const children = [
      {
        key: 'investigate',
        contract: {
          goal: 'disprove the hypothesis using evidence',
          artifact: 'finding.json',
          template: { id: 'investigation', digest: 'a'.repeat(64) },
          skills: ['evidence-reuse'],
          capabilities: ['measure'],
          inputs: [],
          criteria: [{ criterionId: 'finding', statement: 'the conclusion follows from cited data' }],
        },
        supports: ['parent'],
        dependsOn: [],
        maxRuns: 1,
        requirement: 'required' as const,
        handoff: {
          decisions: ['Investigate the banked mechanism first'],
          hypotheses: ['Bank reuse may reduce area'],
          exclusions: ['Do not repeat the existing baseline'],
          evidence: ['verified-baseline'],
        },
      },
    ]
    await s.tools
      .find(t => t.name === 'singularity_decompose_task')!
      .execute({ children }, execFor(agentFor('a', 'a'), 'decompose'))
    expect(got).toEqual({ taskId: 'host-task', children })
  })
  it('requires the same complete child contract for reusable and authored responsibilities', async () => {
    let calls = 0
    const s = scope({
      decompose: async input => {
        calls++
        return { taskId: input.taskId, opened: [], next: 'End this turn' }
      },
    })
    apply(s.ctx)
    const decompose = s.tools.find(tool => tool.name === 'singularity_decompose_task')!
    const child = { key: 'finding', dependsOn: [], supports: ['parent'], maxRuns: 1, requirement: 'required' as const }
    const exec = execFor(agentFor('a', 'a'), 'decompose')
    await expect(
      decompose.execute({ children: [{ ...child, template: 'investigation' }] }, exec),
    ).rejects.toBeInstanceOf(ToolArgsError)
    await expect(
      decompose.execute({ children: [{ ...child, contract: { goal: 'investigate' } }] }, exec),
    ).rejects.toBeInstanceOf(ToolArgsError)
    await expect(
      decompose.execute(
        {
          children: [
            {
              ...child,
              contract: {
                goal: 'investigate',
                artifact: 'finding.json',
                inputs: [],
                criteria: [{ criterionId: 'finding', statement: 'cite evidence for the conclusion' }],
              },
              handoff: { context: 'This contains a second goal', evidence: [] },
            },
          ],
        },
        exec,
      ),
    ).rejects.toBeInstanceOf(ToolArgsError)
    expect(calls).toBe(0)
  })
  it('lets task agents read pinned methods and bind producer inputs on demand', async () => {
    const calls: unknown[] = []
    const s = scope({
      history: async input => {
        calls.push(input)
        return {}
      },
    })
    apply(s.ctx)
    const read = s.tools.find(tool => tool.name === 'singularity_read')!
    const exec = execFor(agentFor('a', 'a'), 'read')
    await read.execute({ kind: 'method' }, exec)
    await read.execute(
      { kind: 'template', ref: 'integrate', producers: { finding: 'finding-key', baseline: 'baseline-task' } },
      exec,
    )
    expect(calls).toEqual([
      { kind: 'method' },
      { kind: 'template', ref: 'integrate', producers: { finding: 'finding-key', baseline: 'baseline-task' } },
    ])
  })
  it('refuses a trajectory request missing kind before it can silently read a summary', async () => {
    let calls = 0
    const s = scope({
      history: async () => {
        calls++
        return {}
      },
    })
    apply(s.ctx, { role: 'improve' })
    const read = s.tools.find(tool => tool.name === 'singularity_read')!
    await expect(
      read.execute({ ref: 'business-session', eventSeq: 7 }, execFor(agentFor('a', 'a'), 'read')),
    ).rejects.toBeInstanceOf(ToolArgsError)
    expect(calls).toBe(0)
  })
  it('exposes one optional memory directory and reference read to every role', async () => {
    for (const role of ['root', 'task', 'review', 'improve'] as const) {
      const calls: unknown[] = []
      const s = scope({
        memory: async input => {
          calls.push(input)
          return {}
        },
      })
      apply(s.ctx, { role })
      const memory = s.tools.find(tool => tool.name === 'singularity_memory')!
      const exec = execFor(agentFor('a', 'a'), 'memory')
      await memory.execute({}, exec)
      await memory.execute({ from: 20, count: 10 }, exec)
      await memory.execute({ ref: 'checkpoint-id' }, exec)
      expect(calls).toEqual([{}, { from: 20, count: 10 }, { ref: 'checkpoint-id' }])
      expect(Object.keys(memory.parameters.properties!)).toEqual([
        ...(role === 'task' || role === 'improve' ? ['prepare'] : []),
        'ref',
        'from',
        'count',
      ])
      await expect(memory.execute({ ref: { sessionId: 'other-session' } }, exec)).rejects.toBeInstanceOf(ToolArgsError)
    }
  })
  it('submits an existing file path and propagates unexpected errors', async () => {
    let got: unknown
    const s = scope({
      submit: async input => {
        got = input
        throw Error('storage failed')
      },
    })
    apply(s.ctx)
    await expect(
      s.tools.find(t => t.name === 'singularity_submit')!.execute({ path: 'report.json' }, {} as ToolRunContext),
    ).rejects.toThrow('storage failed')
    expect(got).toEqual({ taskId: 'host-task', path: 'report.json' })
  })
  it('lets the root submit only an exact child Run reference, without a file-writing escape', async () => {
    let got: unknown
    const s = scope({
      submit: async input => {
        got = input
        return {} as never
      },
    })
    apply(s.ctx, { role: 'root' })
    const submit = s.tools.find(tool => tool.name === 'singularity_submit')!
    const exec = execFor(agentFor('root', 'root'), 'submit')
    await expect(submit.execute({ path: 'report.txt' }, exec)).rejects.toBeInstanceOf(ToolArgsError)
    await submit.execute({ sourceTaskId: 'child', sourceRunId: 'verified-run' }, exec)
    expect(got).toEqual({ taskId: 'host-task', sourceTaskId: 'child', sourceRunId: 'verified-run' })
  })
  it('accepts only reviewer findings and rejects model-authored bindings before invoking the host', async () => {
    const received: unknown[] = []
    const s = scope({
      submit: async input => {
        received.push(input)
        return {} as never
      },
    })
    apply(s.ctx, { role: 'review' })
    const submit = s.tools.find(tool => tool.name === 'singularity_submit')!
    const exec = execFor(agentFor('reviewer', 'reviewer'), 'judgment')
    const findings = [
      {
        criterionId: 'correct',
        verdict: 'pass',
        detail: 'The sealed output matches.',
        evidence: ['submitted-artifact'],
      },
    ]
    await submit.execute({ findings }, exec)
    for (const injected of [
      { path: 'review.json' },
      { findings, subjectDigest: 'mistyped' },
      { findings, reviewId: 'another-review' },
      { findings: [{ ...findings[0], artifactDigest: 'forged' }] },
    ])
      await expect(submit.execute(injected, exec)).rejects.toBeInstanceOf(ToolArgsError)
    expect(received).toEqual([{ findings }])
  })
})
