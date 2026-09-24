import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CapabilityConfig, DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { disposeRunStacks, startRunStack, writeKnowledgeSkill, type RunStack, type ToolCallResult } from '../support/run-stack.ts'

/**
 * S1-C acceptance: "a child node decomposes recursively without guessing a
 * capability name".
 *
 * The cascade is driven the way a live one is: the runtime spawns the child's
 * worker, the child's worker goes idle only after it has called the real
 * `task_decompose` tool — with the capability name it read out of its own run
 * summary, never a name the test handed it — and the nested cascade then spawns
 * the grandchild. What has to hold at both depths:
 *
 * - the spawn request's contract block *and* prompt carry the run's chosen
 *   capability/skill summary, rendered from the same record and the same function
 *   `task_read` renders, so the three views cannot describe different runs;
 * - `capability_list` is visible to the grandchild and answers with a provider
 *   status row for the capability it can require;
 * - the grandchild's worker actually loads the bound bytes.
 *
 * What is real: the store, admission, the pre-check, the run binding and snapshot,
 * the real `task_decompose`/`task_read`/`capability_list` tools, the real
 * `AgentRuntime.spawn` with the real skill layer, and the real `VerifierRegistry`.
 * Only the model loop is scripted (the worker hook), and its one scripted act is
 * the decomposition a live worker would decide to make.
 */

const ROW = 'design-ball'
const SKILL = 's1c-recursive-fixture'
const ROOT = 's-root' as SessionId
const BODY = 'KNOWLEDGE BODY: how a ball is aligned'

afterEach(async () => {
  await disposeRunStacks()
})

/** One summary line as `renderRunBinding` writes it — asserted by prefix so the digest tail is not hard-coded. */
function summaryStart(capability: string, skill: string, role: string): string {
  return `- capability \`${capability}\` → skill \`${skill}\` [${role}] — `
}


/**
 * The root contract this spec's trees run under (A0 §1.2): one goal, one
 * criterion a command settles. The intake is real here — these cases are about
 * what happens to a live tree — so the contract is stated explicitly rather than
 * defaulted: a root contract owes at least one mandatory criterion judged by
 * something other than the composite conjunction, and a fixture that supplied one
 * silently would be answering the question under test.
 */
function rootContract(objective: string): RootContractSpec {
  return {
    objective,
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
  }
}

describe('a child that decomposes further (S1-C)', () => {
  it('tells the grandchild what its run chose, and lets it name the capability from that summary', async () => {
    const capabilities: Record<string, CapabilityConfig> = { [ROW]: { skills: [SKILL], tools: ['filesystem', 'bash'] } }
    let h!: RunStack
    /** The child worker's own `task_decompose` answer, captured as the live cascade produced it. */
    let decomposeAnswer: ToolCallResult | undefined
    h = await startRunStack({
      capabilities,
      roots: [ROOT],
      tools: true,
      worker: async (sessionId: SessionId, agent: Agent) => {
        const { task } = await h.runtime.runForSession(sessionId)
        // The child (depth 1) splits further; the grandchild does its work here and
        // is judged by the real command verifier.
        if (task.depth !== 1) return
        const read = await h.call(agent, 'task_read', {})
        const named = /capability `([^`]+)` → skill `/.exec(read.text)
        if (named === null) throw new Error(`the child's own summary named no capability:\n${read.text}`)
        decomposeAnswer = await h.call(agent, 'task_decompose', {
          reason: 'the ball work turns out not to be atomic',
          children: [{
            objective: 'align one ball dimension',
            acceptanceCriteria: [{ description: 'the dimension is aligned', command: 'true' }],
            requiredCapabilities: [named[1]!],
          }],
        })
      },
    })
    await writeKnowledgeSkill(join(h.home, 'skills'), SKILL, BODY)

    const root = await h.root(ROOT, rootContract('ship the release'))
    const batch = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT, {
      reason: 'split the work',
      children: [{
        objective: 'align the ball',
        acceptanceCriteria: [{ description: 'the ball is aligned', command: 'true' }],
        requiredCapabilities: [ROW],
        decomposable: true,
      }] as DecomposeSpec['children'],
    })
    const outcomes = await h.runtime.awaitBatch(root.storeId, batch.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    // The child's own decompose went through the real tool and was admitted: the
    // name it used came from its summary, not from the test. The tool returns at
    // admission (A3 §3.1), so what it reports is the batch, not a verdict.
    if (decomposeAnswer === undefined) throw new Error('the child never decomposed')
    expect(decomposeAnswer.isError).toBe(false)
    expect(decomposeAnswer.text).toContain('decomposed')
    expect(decomposeAnswer.text).toContain('does not wait for the batch')
    expect(decomposeAnswer.text).toContain('phase waiting_children')

    // The tree the store holds: root → child (settled by the nested cascade) → grandchild.
    const snapshot = await h.snapshot(root.storeId)
    const childTask = snapshot.tasks.find(task => task.taskId === outcomes[0]!.taskId)!
    const grandchildTask = snapshot.tasks.find(task => task.parentTaskId === childTask.taskId)!
    expect(childTask.depth).toBe(1)
    expect(grandchildTask.depth).toBe(2)
    expect(childTask.status).toBe('verified')
    expect(grandchildTask.status).toBe('verified')
    expect(grandchildTask.requestedCapabilities).toEqual([ROW])
    // Exactly two workers were spawned: the child and the grandchild.
    expect(h.spawns).toHaveLength(2)

    const grandchildRun = await h.task.runIn(root.storeId, grandchildTask.runIds[0]!)
    const grandchildBinding = grandchildRun.providerBinding!
    expect(grandchildBinding.capabilities).toEqual([ROW])
    expect(grandchildBinding.skills.map(skill => skill.name)).toEqual([SKILL])
    expect(grandchildBinding.skills[0]!.role).toBe('knowledge')

    // 1. The grandchild's own assembled request: what the run chose for it is in
    // the request the model really received — the context projection's
    // "Implementation chosen for this run", read from the record this run was
    // bound to (A2: the contract block that used to ride the spawn is now the
    // assembled `singularity:worker-contract` section, and the spawn request
    // itself carries no rendering at all).
    const request = h.spawns.find(item => item.sessionId === grandchildRun.sessionId)!
    expect(request.taskWorker).toBe(true)
    expect(request.prompt).toBeUndefined()
    expect(request.contract).toBeUndefined()
    const line = summaryStart(ROW, SKILL, 'knowledge')
    const grandchildTexts = await h.assemblePrompt(h.agent(grandchildRun.sessionId as SessionId)!)
    expect(grandchildTexts).toContain('## Implementation chosen for this run')
    expect(grandchildTexts).toContain(line)
    expect(grandchildTexts).toContain(`content ${grandchildBinding.skills[0]!.contentDigest.slice(0, 12)}`)
    expect(grandchildTexts).toContain(`registry revision: ${grandchildBinding.registryRevision.slice(0, 12)}`)

    // 2. `task_read`, read through the tool as the grandchild, renders the same
    // line — one record, one renderer, two readers.
    const grandchild = h.agent(grandchildRun.sessionId as SessionId)!
    const read = await h.call(grandchild, 'task_read', {})
    expect(read.isError).toBe(false)
    expect(read.text).toContain(line)
    expect(read.text).toContain(`content ${grandchildBinding.skills[0]!.contentDigest.slice(0, 12)}`)

    // 3. `capability_list` is visible to the grandchild and answers with the
    // provider status row for the capability it may require.
    expect(h.visible(grandchild)).toContain('capability_list')
    const listed = await h.call(grandchild, 'capability_list', {})
    expect(listed.isError).toBe(false)
    expect(listed.text).toContain(`- ${ROW} — `)
    expect(listed.text).toContain(`providers: ${SKILL} → knowledge`)
    expect(listed.text).toContain(`skill roots searched for this session: `)
    expect(listed.text).toContain(join(h.home, 'skills'))

    // 4. And the grandchild's worker holds the bytes its own run was bound to.
    const registered = await h.ctx.skills.get(SKILL, { scope: grandchild, cwd: h.checkout })
    expect(registered?.content).toContain(BODY)
    expect(registered!.path!.startsWith(grandchildBinding.snapshotRoot!)).toBe(true)
    expect((await h.runtime.readRunBinding(grandchildBinding))?.defects).toEqual([])
    // The child's own run was bound separately: the snapshot is per run.
    const childRun = await h.task.runIn(root.storeId, childTask.runIds[0]!)
    expect(childRun.providerBinding!.snapshotRoot).not.toBe(grandchildBinding.snapshotRoot)
  })
})
