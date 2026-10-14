import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import { apply, taskGuidance, reviewGuidance } from '../src/agent.ts'
import type { AgentTaskSurface } from '../src/driver.ts'
import { agentFor, execFor } from './seam.ts'
function scope(surface: Partial<AgentTaskSurface> = {}) {
  const tools: ToolDefinition[] = [],
    effects: (() => void)[] = [],
    disposed: string[] = []
  const ctx = {
    singularity: { purpose: () => 'solve', forCall: () => ({ current: () => 'host-task', ...surface }) },
    tools: {
      register: (tool: ToolDefinition) => {
        tools.push(tool)
        return () => disposed.push(tool.name)
      },
    },
    systemPrompt: { section: () => () => disposed.push('prompt') },
    effect: (f: () => () => void) => effects.push(f()),
  } as unknown as Context
  return { ctx, tools, dispose: () => effects.forEach((f) => f()), disposed }
}
describe('small role interfaces', () => {
  it.each([
    [
      'task',
      [
        'singularity_read',
        'singularity_submit',
        'singularity_decompose_task',
        'singularity_ask_parent',
        'singularity_answer',
        'singularity_retry_task',
        'singularity_run_method',
      ],
    ],
    ['review', ['singularity_read', 'singularity_submit', 'singularity_decompose_task', 'singularity_answer']],
    ['improve', ['singularity_read', 'singularity_submit', 'singularity_create_method', 'singularity_evolve_method']],
  ] as const)('mounts only %s operations', (role, names) => {
    const s = scope()
    apply(s.ctx, { role })
    expect(s.tools.map((t) => t.name)).toEqual(names)
    const kinds = (s.tools.find((t) => t.name === 'singularity_read')!.parameters.properties as {
      kind: { enum: readonly string[] }
    }).kind.enum
    if (role === 'task') expect(kinds).toEqual(['summary', 'task', 'artifact', 'template', 'trajectory'])
    for (const tool of s.tools) {
      const keys = Object.keys(tool.parameters.properties ?? {})
      expect(keys).not.toContain('taskId')
      expect(keys).not.toContain('agentId')
      expect(keys).not.toContain('program')
    }
    s.dispose()
    expect(s.disposed).toHaveLength(names.length + 1)
  })
  it('binds structured child responsibilities to the actual current owner', async () => {
    let got: unknown
    const s = scope({
      decompose: async (input) => {
        got = input
        return { taskId: input.taskId, opened: [] } },
    })
    apply(s.ctx)
    const children = [
      {
        key: 'investigate',
        contract: {
          goal: 'disprove the hypothesis using evidence',
          artifact: 'finding.json',
          inputs: [],
          criteria: [{ criterionId: 'finding', statement: 'the conclusion follows from cited data' }],
        },
        supports: ['parent'],
        dependsOn: [],
        maxRuns: 1,
      },
    ]
    await s.tools
      .find((t) => t.name === 'singularity_decompose_task')!
      .execute({ children }, execFor(agentFor('a', 'a'), 'decompose'))
    expect(got).toEqual({ taskId: 'host-task', children })
  })
  it('submits an existing file path and propagates unexpected errors', async () => {
    let got: unknown
    const s = scope({
      submit: async (input) => {
        got = input
        throw Error('storage failed')
      },
    })
    apply(s.ctx)
    await expect(
      s.tools.find((t) => t.name === 'singularity_submit')!.execute({ path: 'report.json' }, {} as ToolRunContext),
    ).rejects.toThrow('storage failed')
    expect(got).toEqual({ taskId: 'host-task', path: 'report.json' })
  })
  it('keeps the default guidance short and separates checking from solving', () => {
    expect(Buffer.byteLength(taskGuidance)).toBeLessThan(1500)
    expect(Buffer.byteLength(reviewGuidance)).toBeLessThan(1200)
    expect(taskGuidance).not.toContain('Revision')
    expect(reviewGuidance).toContain('An honest fail judgment completes')
  })
})
