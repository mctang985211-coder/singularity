import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CapabilityConfig, DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { disposeRunStacks, startRunStack, writeKnowledgeSkill } from '../support/run-stack.ts'

/**
 * S1-C acceptance: "loading an unselected skill does not widen a worker's tool
 * permissions".
 *
 * The run's capability grant authorizes; a skill body is content. The grant owns
 * both planes of a worker (`agent-runtime/src/grants.ts`): the tool surface is
 * restricted to the capability's labels plus the baseline, and the worker's own
 * catalog is an isolated registry holding exactly its Run's frozen grant skills,
 * so the deployment catalog's other skills are not in this worker's catalog at
 * all. The unselected skill is therefore not merely ungranted here: the worker's
 * real `skill` loader refuses it by name, while the deployment's own registry
 * still holds it. What the grant owns is also the tool plane, and that is what
 * this spec reads back twice: from the registry's own view of the worker's
 * composition, and from actual dispatches — before and after the refused load, and
 * after a second attempt at a tool the worker was never granted.
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
  'graph_spawn', 'graph_mark_ready', 'hitl_ask', 'hitl_approve', 'task_intake', 'task_review_pack', 'task_review_agent',
  'task_diagnose', 'evolution_propose', 'evolution_candidate', 'evolution_prepare', 'evolution_replay',
  'evolution_gate', 'evolution_decide', 'evolution_apply', 'evolution_rollback', 'evolution_list', 'escalate',
]

/** The baseline plus the row's own labels: what this worker's grant resolves to. */
const GRANTED_TOOLS = [
  'bash', 'capability_list', 'task_template_list', 'context_read', 'edit', 'glob', 'grep', 'job_kill', 'job_list', 'job_output',
  'read', 'skill', 'task_cancel', 'task_decompose', 'task_read', 'task_status',
  'task_submit_result', 'task_verify', 'write', 'ask_user_question',
]

/**
 * The four raw cross-session readers (A2): the grant names none of them, the
 * baseline that used to carry the exact-read ones no longer does, and the
 * execution seal makes the surface a second line rather than the only one —
 * `worker-grant.spec.ts` drives the denial itself.
 */
const RAW_SESSION_READS = ['session_search', 'session_event_read', 'session_event_trace', 'session_trace']


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
    objective, requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
  }
}

describe('an unselected skill and a worker\'s tool plane (S1-C)', () => {
  it('refuses the deployment catalog skill to a granted worker without moving a single tool the grant did not give', async () => {
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

    const root = await h.root(ROOT, rootContract('ship the release'))
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
    for (const name of RAW_SESSION_READS) expect(before, name).not.toContain(name)
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

    // The deployment catalog really holds the unselected skill, and its body comes
    // from the catalog copy: nothing is hidden from the deployment's own registry.
    const catalog = await h.ctx.skills.get(UNSELECTED, { scope: worker, cwd: h.checkout })
    expect(catalog?.content).toContain('UNSELECTED BODY')
    expect(catalog!.path!.startsWith(unselected)).toBe(true)

    // The worker's own catalog is its Run's frozen grant, not the deployment's:
    // the real loader refuses a name the grant never named, before it reads any
    // body.
    const loaded = await h.call(worker, 'skill', { name: UNSELECTED })
    expect(loaded.isError).toBe(true)
    expect(loaded.text).toContain(UNSELECTED)

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

    // The granted skill is what this worker loads, out of the Run's own frozen
    // snapshot — the binding is the catalog, and the unselected name was never
    // part of it.
    const granted = await h.call(worker, 'skill', { name: GRANTED })
    expect(granted.isError).toBe(false)
    expect(granted.text).toContain('GRANTED BODY')
    expect(granted.text).toContain(run.providerBinding!.snapshotRoot!)
    expect(run.providerBinding!.skills.map(skill => skill.name)).toEqual([GRANTED])
  })
})
