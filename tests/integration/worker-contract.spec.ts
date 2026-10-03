import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import { RuntimeContextProjection, SystemPromptProjection } from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/lib/types/runtime-context.js'
import { joinContextSections, renderContextSections } from '../../../../thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import { bindScopeParent, createScope } from '../../../../thirdparty/deepseek-harness/packages/core/scope/lib/index.js'
import { SessionId } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import type { Session } from '@deepseek-ai/dsh-session'
import { startAssemblyStack, type AssemblyStack } from '../support/assembly-stack.ts'

/**
 * The contract as the loop treats it, on the real seams: the assembled request is
 * the production `system-prompt/assemble` waterfall over the store (A2 — no spawn
 * prompt carries a contract any more), and the real `SystemPromptProjection` is
 * what the loop drives on every step, so what is asserted here is what the model
 * would be sent on an ordinary step and after a fold, not a paraphrase of it.
 *
 * The `SystemPromptProjection` import reaches into the upstream package's emitted
 * files because the class is not on that package's export map
 * (`@deepseek-ai/dsh-agent-loop` exports `.` and `./invariant` only). It is the
 * mechanism the contract rides: a change there should break this test rather than
 * pass silently.
 */

/** The three route/series shapes the loop hands `project` (`agent-loop/src/agent.ts`). */
const REPLACING = { inHistory: false, startsSeries: false }
const CONTINUING = { inHistory: true, startsSeries: false }
const NEW_SERIES = { inHistory: true, startsSeries: true }

const stacks: AssemblyStack[] = []

async function boot(): Promise<AssemblyStack> {
  const stack = await startAssemblyStack({ worker: async () => {} })
  stacks.push(stack)
  return stack
}

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.dispose()
  vi.unstubAllEnvs()
})

/** The store, its root session, and one delegated worker of a real chain. */
async function chain(stack: AssemblyStack): Promise<{ storeId: string; workerSession: string; workerTaskId: string }> {
  const rootSession = stack.roots[0]!
  const storeId = stack.storeIdOf(rootSession)
  await stack.seedLog(rootSession, ['ship the release'])
  const root = await stack.runtime.intakeRootContract(storeId, rootSession, { requiredCapabilities: ['execute-task'],
    objective: 'ship the release',
    acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
  })
  const batch = await stack.runtime.decomposeAndRun(storeId, root.taskId, root.runId, rootSession, {
    reason: 'split the work',
    children: [{ requiredCapabilities: ['execute-task'],
      objective: 'implement the feature',
      // This fixture settles a contract for prompt/permission assertions; it tests no engineering result.
      acceptanceCriteria: [{ description: 'fixture acceptance passes', command: 'true' }],
    }],
  } as never)
  await stack.runtime.awaitBatch(storeId, batch.batchId)
  const state = await stack.snapshot(storeId)
  const childTask = state.tasks.find(task => task.parentTaskId === root.taskId)!
  const run = state.runs.find(candidate => candidate.taskId === childTask.taskId)!
  return { storeId, workerSession: String(run.sessionId), workerTaskId: childTask.taskId }
}

/** Commit one projection candidate to a session the way the loop's own commit does. */
function commit(session: Session, candidate: ReturnType<SystemPromptProjection['project']>[number] | undefined) {
  if (candidate === undefined) throw new Error('expected a system-prompt commit')
  return session.append('system/message', { turn: 1, step: 1, message: candidate.message }, candidate.intent)
}

function appendUser(session: Session, text: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function textOf(session: Session, index: number): string {
  const block = session.deriveMessages()[index]?.content[0]
  return block?.type === 'text' ? block.text : ''
}

describe('the assembled request a worker receives', () => {
  it('carries the contract as one section, and the worker policy sits ahead of it', async () => {
    const stack = await boot()
    const { workerSession, workerTaskId } = await chain(stack)

    const prompt = await stack.prompt(workerSession)
    // The contract: the store's own facts, projected from the callers' records.
    expect(prompt).toContain('# Immutable context (contract)')
    expect(prompt).toContain('role: worker')
    expect(prompt).toContain(`task ${workerTaskId}`)
    expect(prompt).toContain('objective: implement the feature')
    // One copy, not a stack: this is a section, not an appended reminder, however
    // often the request is assembled.
    expect(prompt.split('# Immutable context (contract)')).toHaveLength(2)
    // The stable role policy is the agent runtime's section, ahead of the contract,
    // and it is not a second copy of it.
    expect(prompt).toContain('You are a Singularity task worker.')
    expect(prompt).toContain('Follow them for the delegated work. Own your result and its acceptance')
    expect(prompt).toContain('### Skill task-execution')
    expect(prompt).toContain('the complete instructions from this Run’s frozen Skill snapshot')
    expect(prompt.indexOf('You are a Singularity task worker.')).toBeLessThan(prompt.indexOf('# Immutable context (contract)'))
    // The stable policy names no raw cross-session reader (A2): history is read
    // with `context_read`.
    expect(prompt).not.toContain('session_event_read')
    expect(prompt).not.toContain('session_trace')

    // Assembling again changes nothing: the same sections, in the same order.
    expect(await stack.prompt(workerSession)).toBe(prompt)
  })

  it('gives the graph root its own contract and never a worker\'s briefing', async () => {
    const stack = await boot()
    await chain(stack)
    const rootPrompt = await stack.prompt('s-root')
    expect(rootPrompt).toContain('## Your contract (graph root)')
    expect(rootPrompt).toContain('objective: ship the release')
    expect(rootPrompt).toContain('coordinate the user\'s complete objective through task workers')
    expect(rootPrompt).toContain('Before intake, load task-coordination with skill and follow its method')
    expect(rootPrompt).toContain('Every business Task, including your root contract, must select at least one relevant guidance Skill')
    expect(rootPrompt).not.toContain('role: worker')
    expect(rootPrompt).not.toContain('You are a Singularity task worker.')
  })

  it('denies root-local execution tools while workers keep their granted tools', async () => {
    const stack = await boot()
    const root = stack.root()
    const invoked = vi.fn(async () => 'fixture result')
    for (const name of ['subagent', 'subagent_fork', 'read', 'grep', 'write', 'edit', 'bash']) {
      // Preset-generated definitions can live on the agent's own plane, where
      // tools.restrict does not apply. The execution guard must still deny them.
      root.ctx.tools.register({
        name,
        description: 'agent-owned fixture',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
        execute: invoked,
      })
      expect(stack.ctx.tools.get(name, root), name).toBeDefined()
      const answer = await stack.call(root.id, name)
      expect(answer.isError, name).toBe(true)
      expect(answer.text, name).toContain('delegate engineering work with task_decompose')
    }
    expect(invoked).not.toHaveBeenCalled()
    const { workerSession } = await chain(stack)
    expect((await stack.call(workerSession, 'read')).isError).toBe(false)
    expect((await stack.call(workerSession, 'bash')).isError).toBe(false)
    expect(stack.executed()).toContain('read')
    expect(stack.executed()).toContain('bash')
  })

  it.each(['ptc', 'both'] as const)(
    'keeps roots native under %s while workers retain the deployment transport',
    async mode => {
      const stack = await startAssemblyStack({ worker: async () => {}, toolsMode: mode })
      stacks.push(stack)
      const run = vi.fn(async () => {
        throw new Error('the fixture must never execute a program')
      })
      stack.ctx.provide('ptcRuntime', { language: 'typescript', isolation: 'process', run } as never)
      const root = stack.root()
      const rootSchemas = (await stack.assemble(root.id)).tools.map(tool => tool.name)
      expect(rootSchemas).toContain('task_read')
      expect(rootSchemas).not.toContain('run_code')
      expect(stack.ctx.tools.get('run_code', root)).toBeUndefined()
      expect(stack.ctx.tools.schemas(root).map(tool => tool.name)).not.toContain('run_code')
      const denied = await stack.call(root.id, 'run_code', { program: "console.log('never executed')" })
      expect(denied.isError).toBe(true)
      expect(run).not.toHaveBeenCalled()
      expect((await stack.call(root.id, 'task_read')).isError).toBe(false)

      const { workerSession } = await chain(stack)
      const worker = stack.agent(workerSession)!
      expect(stack.ctx.tools.get('run_code', worker)).toBeDefined()
      expect((await stack.assemble(workerSession)).tools.map(tool => tool.name)).toContain('run_code')
      expect(stack.ctx.tools.get('read', worker)).toBeDefined()
      expect(stack.ctx.tools.get('bash', worker)).toBeDefined()
      expect(run).not.toHaveBeenCalled()
    },
  )

  it('root native presentation wins over a parent preset PTC presentation', async () => {
    const stack = await boot()
    const run = vi.fn(async () => {
      throw new Error('the fixture must never execute a program')
    })
    stack.ctx.provide('ptcRuntime', { language: 'typescript', isolation: 'process', run } as never)
    const presetKey = {}
    await stack.ctx.plugin(
      Object.assign(
        (ctx: typeof stack.ctx) => {
          const preset = createScope(ctx, presetKey)
          preset.ctx.tools.presentAs('ptc')
        },
        { inject: ['tools', 'systemPrompt'] },
      ),
    )
    const root = stack.root()
    bindScopeParent(root, presetKey)
    expect((await stack.assemble(root.id)).tools.map(tool => tool.name)).not.toContain('run_code')
    expect(stack.ctx.tools.get('run_code', root)).toBeUndefined()
    expect((await stack.call(root.id, 'run_code', { program: "console.log('never executed')" })).isError).toBe(true)
    expect((await stack.call(root.id, 'task_read')).isError).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('injects nothing for a session that is no part of this deployment', async () => {
    const stack = await boot()
    const prompt = await stack.prompt('s-nobody')
    expect(prompt).not.toContain('# Immutable context (contract)')
    expect(prompt).not.toContain('singularity')
  })
})

describe('what the projection does with the assembled contract, step after step', () => {
  async function projected(): Promise<{ session: Session; rendered: string }> {
    const stack = await boot()
    const { workerSession } = await chain(stack)
    const rendered = await stack.prompt(workerSession)
    return { session: stack.ctx.sessions.create(SessionId('s-worker')), rendered }
  }

  it('reserves node 0 once and then writes nothing while the contract is unchanged', async () => {
    const { session, rendered } = await projected()
    const projection = new SystemPromptProjection(session)

    const first = projection.project(rendered, REPLACING)
    expect(first).toHaveLength(1)
    expect(first[0]!.intent).toEqual({ surfaceOp: 'append' })
    commit(session, first[0])
    expect(textOf(session, 0)).toContain('# Immutable context (contract)')

    // Every later step re-projects the same text and commits nothing — which is
    // the whole difference between reinjecting a contract and spamming one.
    expect(projection.project(rendered, REPLACING)).toEqual([])
    expect(session.surface.nodes).toHaveLength(1)
  })

  it('keeps the contract on the surface after a fold shadows the kickoff, with no extra write', async () => {
    const { session, rendered } = await projected()
    const projection = new SystemPromptProjection(session)
    commit(session, projection.project(rendered, REPLACING)[0])
    const kickoffSeq = appendUser(session, 'Begin your delegated task.').seq
    expect(session.deriveMessages()).toHaveLength(2)

    // Compaction folds the kickoff into a checkpoint: the session's only other
    // copy of the contract's context is gone.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Earlier work summarised.' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: kickoffSeq, endSeq: kickoffSeq },
      sourceEventSeqs: [kickoffSeq],
    })
    expect(session.deriveMessages().map(message => message.role)).toEqual(['system', 'user'])
    expect(textOf(session, 1)).toBe('Earlier work summarised.')

    // The surface was replaced, so this step re-projects...
    expect(projection.project(rendered, { inHistory: false, startsSeries: true })).toEqual([])
    // ...and the contract is still the first thing the model reads.
    expect(textOf(session, 0)).toContain('# Immutable context (contract)')
    expect(textOf(session, 0)).toContain('objective: implement the feature')
  })

  it('writes the contract back exactly once when the surface lost it, then goes quiet', async () => {
    const { session, rendered } = await projected()
    const projection = new SystemPromptProjection(session)
    commit(session, projection.project(rendered, REPLACING)[0])

    // A prompt that no longer carries the section leaves node 0 empty: the
    // contract is outside the visible surface.
    const emptied = projection.project('', REPLACING)
    expect(emptied).toHaveLength(1)
    commit(session, emptied[0])
    expect(session.deriveMessages()).toEqual([])

    const restored = projection.project(rendered, REPLACING)
    expect(restored).toHaveLength(1)
    expect(restored[0]!.intent).toMatchObject({ surfaceOp: { op: 'replace' } })
    commit(session, restored[0])
    expect(textOf(session, 0)).toContain('# Immutable context (contract)')
    expect(session.deriveMessages()).toHaveLength(1)

    expect(projection.project(rendered, REPLACING)).toEqual([])
    expect(session.deriveMessages()).toHaveLength(1)
  })

  it('holds on an in-history route too: a changed prompt appends once, a new series collapses back', async () => {
    const { session, rendered } = await projected()
    const projection = new SystemPromptProjection(session)
    commit(session, projection.project(rendered, REPLACING)[0])
    appendUser(session, 'Begin your delegated task.')

    // `in-history` routes read the LAST system node as the effective prompt, so
    // a changed prompt is appended rather than replacing node 0.
    const appended = projection.project(`${rendered}\n\n## Runtime context\n\ncurrent step: 2`, CONTINUING)
    expect(appended).toHaveLength(1)
    expect(appended[0]!.intent).toEqual({ surfaceOp: 'append' })
    commit(session, appended[0])
    expect(session.deriveMessages().map(message => message.role)).toEqual(['system', 'user', 'system'])
    expect(textOf(session, 0)).toContain('# Immutable context (contract)')
    expect(textOf(session, 2)).toContain('# Immutable context (contract)')

    // A new series (the surface was replaced) empties the tail rather than
    // leaving two live prompts behind; node 0 already holds this text, so the
    // collapse costs exactly that one write.
    const collapsed = projection.project(rendered, NEW_SERIES)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]!.intent).toMatchObject({ surfaceOp: { op: 'replace' } })
    for (const update of collapsed) commit(session, update)
    expect(session.deriveMessages().map(message => message.role)).toEqual(['system', 'user'])
    expect(textOf(session, 0)).toContain('# Immutable context (contract)')
    expect(projection.project(rendered, NEW_SERIES)).toEqual([])
  })

  it('commits the dynamic context snapshot once, then commits nothing while it is unchanged', async () => {
    // The dynamic half rides DSH's runtime-context plane (A2 §D): this drives
    // the loop's own RuntimeContextProjection the way agent.ts does — project
    // the assembled contexts, commit the candidate, project again — so the
    // dedup that keeps repeated assemblies from stacking snapshots is the real
    // one, not a re-assertion of this package's byte-stability.
    const stack = await boot()
    const { workerSession } = await chain(stack)
    const assembly = await stack.assemble(workerSession)
    const sections = renderContextSections(assembly)
    expect(sections.map(section => section.name)).toContain('singularity:state')
    const current = joinContextSections(sections)

    const session = stack.ctx.sessions.create(SessionId('s-worker'))
    const projection = new RuntimeContextProjection(stack.ctx, session)
    const first = projection.project(current, sections)
    expect(first).toBeDefined()
    await session.append('user/message', first!, { surfaceOp: 'append' })
    expect(session.deriveMessages()).toHaveLength(1)

    // Step after step with an unchanged projection: no candidate, no write.
    expect(projection.project(current, sections)).toBeUndefined()
    expect(session.deriveMessages()).toHaveLength(1)
  })
})
