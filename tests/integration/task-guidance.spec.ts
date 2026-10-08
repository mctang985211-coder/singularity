import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { RootContractSpec } from '../../task-runtime/src/index.ts'
import { AssemblyRefusalError } from '../../context/src/index.ts'
import { disposeRunStacks, startRunStack, writeGuidanceSkill } from '../support/run-stack.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptedLoop, type ScriptEntry } from '../support/scripted-loop.ts'

const ROOT = 's-root'
const COORDINATION = fileURLToPath(new URL('../../agent-runtime/skills/task-coordination/SKILL.md', import.meta.url))
const ANSWER_METHOD = 'Read the explicit answer inputs. Compute their requested result and check the independent equality criterion before submitting. ANSWER_METHOD_ORIGINAL'
const capabilities = {
  'coordinate-tasks': { skills: ['task-coordination'], tools: ['filesystem', 'bash'] },
  'answer-guidance': { skills: ['answer-method'] },
  'native-auxiliary': { tools: ['filesystem', 'bash'] },
}
const contract = (objective: string, requiredCapabilities = ['coordinate-tasks']): RootContractSpec => ({
  objective, requiredCapabilities,
  acceptanceCriteria: [{ criterionId: 'goal', description: `${objective} is delivered`, command: 'true' }],
})

async function install(h: { home: string }): Promise<void> {
  const root = join(h.home, 'skills')
  await mkdir(join(root, 'task-coordination'), { recursive: true })
  await copyFile(COORDINATION, join(root, 'task-coordination', 'SKILL.md'))
  await writeGuidanceSkill(root, 'answer-method', ANSWER_METHOD)
}

/**
 * Publish one version of a graph library's own `task-coordination` production
 * method, marked with `marker`. A library's contents move only through the
 * pointer transaction (draft → stage → publish), and it is the *published*
 * revision a Run binds — never a file edited in place.
 */
async function publishCoordination(h: ScriptedLoop, session: string, marker: string): Promise<void> {
  await h.runtime.ensureInitialEnvironment(session, session)
  const active = await h.runtime.libraryRead(session)
  const declared = active.skills.find(entry => entry.name === 'task-coordination')
  const draft = await h.runtime.createDraft(session)
  await h.runtime.stageDraftEdit(session, draft.draftId, {
    kind: 'skill',
    edit: {
      name: 'task-coordination',
      skillMd: `${await readFile(COORDINATION, 'utf8')}\n${marker}\n`,
      expectedVersion: declared?.version ?? 0,
      actor: session,
    },
  })
  await h.runtime.publishRevision(session, {
    direction: 'publish',
    source: { kind: 'draft', draftId: draft.draftId },
    expected: { revisionId: active.revisionId, generation: active.generation },
    actor: session,
  })
}
const textOf = (h: ScriptedLoop, session: string) => h.requestsOf(session).map(request => request.texts.join('\n'))

afterEach(async () => { await disposeScriptedLoops(); await disposeRunStacks() })

describe('guidance on actual model requests', () => {
  it('loads relevant full instructions for the root, coordinating child and atomic leaf without Skill calls', async () => {
    let h!: ScriptedLoop
    h = await startScriptedLoop({ capabilities, script: (session, index): readonly ScriptEntry[] => {
        const waitForChildren = { waitFor: async () => {
          await vi.waitFor(async () => expect((await h.runForSession(session)).run.executionPhase).toBe('active'), { timeout: 10_000 })
        } }
        if (index === 0) return [
          { tool: 'task_decompose', args: { reason: 'coordinate the answer branch', children: [{
            objective: 'coordinate the independently checked answer', requiredCapabilities: ['coordinate-tasks'], decomposable: true,
            acceptanceCriteria: [{ description: 'the answer branch works', command: 'true' }],
          }] } }, waitForChildren, { text: 'answer branch evidence received' },
        ]
        if (index === 1) return [
          { tool: 'task_decompose', args: { reason: 'produce the atomic answer', children: [{
            objective: 'compute the explicit answer', requiredCapabilities: ['answer-guidance', 'native-auxiliary'],
            acceptanceCriteria: [{ description: 'the explicit answer is correct', command: 'true' }],
          }] } }, waitForChildren,
          { tool: 'task_submit_result', args: { summary: 'the checked answer completes this branch' } }, { text: 'submitted branch' },
        ]
        return [{ tool: 'task_submit_result', args: { summary: 'computed and checked the explicit answer' } }, { text: 'submitted answer' }]
      },
    })
    await install(h)
    const root = await h.begin(contract('deliver the checked answer'))
    await vi.waitFor(async () => {
      const snapshot = await h.snapshot(root.storeId)
      expect(snapshot.tasks.filter(task => task.parentTaskId !== undefined).map(task => task.status)).toEqual(['verified', 'verified'])
    }, { timeout: 15_000 })
    const child = h.spawns[0]!.sessionId
    const leaf = h.spawns[1]!.sessionId
    for (const session of [ROOT, child]) {
      expect(textOf(h, session).length).toBeGreaterThan(0)
      for (const text of textOf(h, session)) {
        expect(text).toContain('### Skill task-coordination')
        expect(text).toContain("Read a fitting template's full contract and conditions, then bind its exact reference and parameters.")
        expect(text).toContain('One unfinished batch at a time: answer questions, yield for its end, read results and integrate artifacts.')
      }
    }
    for (const text of textOf(h, leaf)) {
      expect(text).toContain(ANSWER_METHOD)
      expect(text).not.toContain('### Skill task-coordination')
    }
    expect(h.calls.some(call => call.name === 'skill')).toBe(false)
    expect((await h.runForSession(leaf)).task.contract?.requiredCapabilities).toEqual(['answer-guidance', 'native-auxiliary'])
    // The root's own allow-list: the coordination plane plus the execution
    // baseline every root works with, and no evolution tool while the deployment's
    // switch is off. The leaf's grant offers the execution tools and none of the
    // coordination plane.
    for (const name of ['read', 'write', 'edit', 'bash', 'task_decompose']) expect(h.visible(h.agent(ROOT))).toContain(name)
    expect(h.visible(h.agent(ROOT))).not.toContain('evolution_apply')
    for (const name of ['graph_spawn', 'evolution_apply']) expect(h.visible(h.agent(leaf))).not.toContain(name)
    for (const name of ['read', 'write', 'bash']) expect(h.visible(h.agent(leaf))).toContain(name)
  })

  it('keeps an existing Run on frozen bytes and gives a new root Run the edited production method', async () => {
    const h = await startScriptedLoop({ capabilities, roots: [ROOT, 's-new-root'], script: () => [{ text: 'coordinating with the admitted method' }],
    })
    await install(h)
    // Each root graph's own library holds its production method, published as a
    // revision, and a run binds the revision that was active when it was
    // admitted — the graph's own copy, not the deployment catalog's.
    await publishCoordination(h, ROOT, 'FROZEN_COORDINATION_ORIGINAL')
    const root = await h.begin(contract('coordinate the first answer'))
    await h.agent(ROOT).whenIdle()
    expect(textOf(h, ROOT).at(-1)).toContain('FROZEN_COORDINATION_ORIGINAL')
    // A second publish moves the pointer, and the admitted Run stays on the bytes
    // it bound: its own frozen snapshot, not the library's new revision.
    await publishCoordination(h, ROOT, 'PRODUCTION_COORDINATION_REVISED')
    h.userSays('continue under the same accepted contract')
    await h.agent(ROOT).whenIdle()
    expect(textOf(h, ROOT).at(-1)).toContain('FROZEN_COORDINATION_ORIGINAL')
    expect(textOf(h, ROOT).at(-1)).not.toContain('PRODUCTION_COORDINATION_REVISED')
    await h.runtime.submitResult(ROOT, { summary: 'the first accepted coordination is complete' })
    await vi.waitFor(async () => expect((await h.runForSession(ROOT)).run.status).toBe('verified'))
    // The second graph's own production method carries the revised bytes: a Run
    // admitted now binds the revision published for that graph, while the first
    // run stayed on its snapshot.
    await publishCoordination(h, 's-new-root', 'PRODUCTION_COORDINATION_REVISED')
    h.recordRequest('coordinate the second answer', 's-new-root')
    const fresh = await h.runtime.intakeRootContract(rootTaskStoreId('s-new-root'), 's-new-root', contract('coordinate the second answer'))
    expect(fresh.status).toBe('activated')
    h.userSays('begin the second answer', 's-new-root')
    await h.agent('s-new-root').whenIdle()
    expect(textOf(h, 's-new-root').at(-1)).toContain('PRODUCTION_COORDINATION_REVISED')
    expect(textOf(h, 's-new-root').at(-1)).not.toContain('FROZEN_COORDINATION_ORIGINAL')
    expect((await h.task.runIn(root.storeId, root.runId)).providerBinding?.skills[0]?.contentDigest)
      .not.toBe((await h.runForSession('s-new-root')).run.providerBinding?.skills[0]?.contentDigest)
  })

  it.each(['tampered', 'deleted'] as const)('refuses the next actual request when its frozen Skill is %s', async damage => {
    const h = await startScriptedLoop({ capabilities, script: () => [{ text: 'coordinate the answer' }] })
    await install(h)
    await h.begin(contract(`coordinate the ${damage} case`))
    await h.agent(ROOT).whenIdle()
    const { run } = await h.runForSession(ROOT)
    const frozen = join(run.providerBinding!.snapshotRoot!, 'task-coordination', 'SKILL.md')
    if (damage === 'tampered') await writeFile(frozen, 'changed snapshot')
    else await rm(frozen)
    const before = h.requestsOf(ROOT).length
    const failures: unknown[] = []
    h.ctx.on('agent/error', ({ error }: { error: unknown }) => { failures.push(error) })
    h.userSays('attempt the next model request')
    await h.agent(ROOT).whenIdle().catch(() => {})
    expect(h.requestsOf(ROOT)).toHaveLength(before)
    expect(failures.length).toBeGreaterThan(0)
    expect(failures[0]).toBeInstanceOf(AssemblyRefusalError)
    expect((failures[0] as Error).message).toContain('frozen guidance Skill')
  })
})

describe('guidance admission', () => {
  it('admits a relevant guidance row alongside a pure MCP auxiliary row', async () => {
    const h = await startRunStack({ capabilities: { ...capabilities,
      'echo-auxiliary': { mcpServers: ['echo'] },
    }, mcpServers: { echo: { serverName: 'echo-fixture', description: 'echo auxiliary', command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/echo-mcp-server.mjs', import.meta.url))] } }, tools: true })
    await install(h)
    const root = await h.root(ROOT, contract('coordinate the echo answer'))
    const batch = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT, {
      reason: 'compute one answer with an auxiliary echo', children: [{ objective: 'compute the explicit echo answer',
        requiredCapabilities: ['answer-guidance', 'echo-auxiliary'],
        acceptanceCriteria: [{ description: 'the echo answer works', command: 'true' }] }],
    })
    const [outcome] = await h.runtime.awaitBatch(root.storeId, batch.batchId)
    expect(outcome?.status).toBe('verified')
    const run = await h.task.runIn(root.storeId, outcome!.runId!)
    expect(run.providerBinding?.skills.map(skill => skill.name)).toEqual(['answer-method'])
    expect(run.providerBinding?.capabilities).toEqual(['answer-guidance', 'echo-auxiliary'])
    expect(run.providerBinding?.mcpServers.map(server => server.serverName)).toEqual(['echo'])
    expect(h.visible(h.agent(run.sessionId)!)).toContain('mcp__echo-fixture__echo')
  })

  it.each([
    ['no capabilities', []], ['native tools only', ['native-only']], ['MCP only', ['mcp-only']],
    ['missing Skill', ['missing-guidance']], ['empty Skill', ['empty-guidance']],
    ['malformed Skill', ['malformed-guidance']], ['disabled Skill', ['disabled-guidance']],
  ] as const)('refuses %s before writing a Task or Run or spawning a child', async (_name, required) => {
    const h = await startRunStack({ capabilities: { ...capabilities,
      'native-only': { tools: ['filesystem'] }, 'mcp-only': { mcpServers: ['echo'] },
      'missing-guidance': { skills: ['missing-method'] }, 'empty-guidance': { skills: ['empty-method'] },
      'malformed-guidance': { skills: ['malformed-method'] }, 'disabled-guidance': { skills: ['disabled-method'] },
    }, mcpServers: { echo: { serverName: 'echo', description: 'auxiliary echo provider', command: 'node', args: [], cwd: '.' } }, tools: true })
    await install(h)
    const skills = join(h.home, 'skills')
    await writeGuidanceSkill(skills, 'empty-method', '   \n')
    await writeGuidanceSkill(skills, 'malformed-method', 'method body', 'wrong-name')
    const disabled = await writeGuidanceSkill(skills, 'disabled-method', 'method body')
    await writeFile(join(disabled, 'SKILL.md'), '---\nname: disabled-method\ndescription: unavailable instructions\ndisable-model-invocation: true\n---\n\nmethod body\n')
    await expect(h.root(ROOT, contract('deliver the answer without admitted guidance', [...required]))).rejects.toThrow(/guidance|skill-file-invalid|not found|name.*wrong-name|provider/i)
    const before = await h.task.snapshotIn(rootTaskStoreId(ROOT))
    expect(before.tasks).toEqual([])
    expect(before.runs).toEqual([])
    const root = await h.root(ROOT, contract('coordinate the admitted answer'))
    await expect(h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT, {
      reason: 'try a child without admitted guidance', children: [{ objective: 'compute the answer',
        requiredCapabilities: [...required], acceptanceCriteria: [{ description: 'answer works', command: 'true' }] }],
    })).rejects.toThrow(/guidance|skill-file-invalid|not found|name.*wrong-name|provider/i)
    const after = await h.task.snapshotIn(root.storeId)
    expect(after.tasks).toHaveLength(1)
    expect(after.runs).toHaveLength(1)
    expect(h.spawns).toEqual([])
  })
})
