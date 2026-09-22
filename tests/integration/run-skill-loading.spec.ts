import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CapabilityConfig, DecomposeSpec } from '../../task-runtime/src/index.ts'
import { disposeRunStacks, startRunStack, writeKnowledgeSkill } from '../support/run-stack.ts'

/**
 * S1-C acceptance: "loading an unselected skill does not widen a worker's tool
 * permissions".
 *
 * The run's capability grant authorizes; a skill body is content. DSH has no
 * per-agent skill *hiding* (`agent-runtime/src/grants.ts` names that boundary), so
 * the unselected skill really is reachable from the deployment catalog — through
 * the real `skill` loader, mounted here as `tool-skill` registers it. What the
 * grant owns is the tool plane, and that is what this spec reads back twice: from
 * the registry's own view of the worker's composition, and from actual dispatches
 * — before and after the load, and after a second attempt at a tool the worker was
 * never granted.
 *
 * What is real: the store, admission, the pre-check, the run binding and snapshot,
 * the real `AgentRuntime.spawn`, the real skill registry with the filesystem
 * provider, the real `skill` tool, and the real `VerifierRegistry`.
 */

const ROW = 'design-ball'
/** Granted by the row, registered into the worker's own layer from its run snapshot. */
const GRANTED = 's1c-granted-fixture'
/** Held by the deployment catalog and granted by nothing in this deployment. */
const UNSELECTED = 's1c-unselected-fixture'
const ROOT = 's-root' as SessionId

afterEach(async () => {
  await disposeRunStacks()
})

/** Every tool the platform keeps for the root and the root's own planes — none of which a granted worker may reach. */
const PLATFORM_TOOLS = [
  'graph_spawn', 'graph_mark_ready', 'hitl_ask', 'hitl_approve', 'task_review_pack', 'task_review_agent',
  'task_diagnose', 'evolution_propose', 'evolution_candidate', 'evolution_prepare', 'evolution_replay',
  'evolution_gate', 'evolution_decide', 'evolution_apply', 'evolution_rollback', 'evolution_list', 'escalate',
]

/** The baseline plus the row's own labels: what this worker's grant resolves to. */
const GRANTED_TOOLS = [
  'bash', 'capability_list', 'edit', 'glob', 'grep', 'job_kill', 'job_list', 'job_output',
  'read', 'session_event_read', 'session_trace', 'skill', 'task_cancel', 'task_decompose', 'task_read', 'task_status',
  'task_submit_result', 'task_verify', 'write', 'ask_user_question',
]

describe('an unselected skill and a worker\'s tool plane (S1-C)', () => {
  it('loads the deployment catalog skill without moving a single tool the grant did not give', async () => {
    const capabilities: Record<string, CapabilityConfig> = { [ROW]: { skills: [GRANTED], tools: ['filesystem', 'bash'] } }
    const h = await startRunStack({
      capabilities,
      roots: [ROOT],
      tools: true,
      skillTool: true,
      discovery: true,
    })
    await writeKnowledgeSkill(join(h.home, 'skills'), GRANTED, 'GRANTED BODY')
    // The project skill root of the checkout the worker runs in: the deployment's
    // own catalog, which grants nothing here.
    mkdirSync(join(h.checkout, '.git'), { recursive: true })
    const unselected = await writeKnowledgeSkill(join(h.checkout, '.agents', 'skills'), UNSELECTED, 'UNSELECTED BODY')

    const root = await h.root(ROOT)
    const batch = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT, {
      reason: 'split the work',
      children: [{
        objective: 'align the ball',
        acceptanceCriteria: [{ description: 'the ball is aligned', command: 'true' }],
        requiredCapabilities: [ROW],
      }] as DecomposeSpec['children'],
    })
    const outcomes = await h.runtime.awaitBatch(root.storeId, batch.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    const run = await h.task.runIn(root.storeId, outcomes[0]!.runId!)
    const worker = h.agent(run.sessionId as SessionId)!
    const before = h.visible(worker)
    const beforeSchemas = JSON.stringify(h.ctx.tools.schemas(worker))

    // The grant resolved to its own plane: capability labels plus baseline, and
    // nothing of the platform.
    for (const name of GRANTED_TOOLS) expect(before, name).toContain(name)
    for (const name of PLATFORM_TOOLS) expect(before, name).not.toContain(name)
    expect(before).not.toContain('web_fetch')
    expect(before).not.toContain('subagent_fetchless')

    // Read back from the tool registration itself, not only from the listing: the
    // names are registered globally (the root reaches them) and absent for this
    // worker, so it is the grant's restriction that removed them.
    expect(h.ctx.tools.get('graph_spawn')).toBeDefined()
    expect(h.ctx.tools.get('graph_spawn', worker)).toBeUndefined()
    expect(h.ctx.tools.get('evolution_apply', worker)).toBeUndefined()
    expect(h.ctx.tools.get('skill', worker)).toBeDefined()

    // A dispatch of a tool the worker was never granted is refused by the registry.
    const denied = await h.call(worker, 'graph_spawn', { objective: 'skip admission' })
    expect(denied.isError).toBe(true)
    expect(denied.text).toContain('graph_spawn')

    // The unselected skill is loadable — the catalog is the deployment's, and DSH
    // has no per-agent hiding — and its body comes from the catalog copy.
    const catalog = await h.ctx.skills.get(UNSELECTED, { scope: worker, cwd: h.checkout })
    expect(catalog?.content).toContain('UNSELECTED BODY')
    expect(catalog!.path!.startsWith(unselected)).toBe(true)

    const loaded = await h.call(worker, 'skill', { name: UNSELECTED })
    expect(loaded.isError).toBe(false)
    expect(loaded.text).toContain('UNSELECTED BODY')

    // The surface did not move: same names, same schemas, and the ungranted tool is
    // still refused afterwards.
    expect(h.visible(worker)).toEqual(before)
    expect(JSON.stringify(h.ctx.tools.schemas(worker))).toBe(beforeSchemas)
    const deniedAfter = await h.call(worker, 'graph_spawn', { objective: 'skip admission' })
    expect(deniedAfter.isError).toBe(true)
    expect(deniedAfter.text).toContain('graph_spawn')

    // And what the grant did give still answers: the capability's own tool and the
    // baseline machinery a worker's prompt names.
    expect((await h.call(worker, 'read', { file_path: join(h.checkout, 'nothing') })).isError).toBe(false)
    expect((await h.call(worker, 'task_read', {})).isError).toBe(false)

    // The run's own record is what the worker loads for the granted skill: the
    // unselected one was never part of the binding.
    const granted = await h.ctx.skills.get(GRANTED, { scope: worker, cwd: h.checkout })
    expect(granted!.path!.startsWith(run.providerBinding!.snapshotRoot!)).toBe(true)
    expect(run.providerBinding!.skills.map(skill => skill.name)).toEqual([GRANTED])
  })
})
