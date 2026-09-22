import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { executionProviders } from '../../task-runtime/src/index.ts'
import type { CapabilityConfig, DecomposeSpec } from '../../task-runtime/src/index.ts'
import { disposeRunStacks, startRunStack, writeKnowledgeSkill } from '../support/run-stack.ts'

/**
 * S1-C acceptance: "a knowledge skill is loadable but closes no execution gap".
 *
 * The distinction the sidecar contract exists for, asserted on the surfaces that
 * decide it:
 *
 * 1. the pre-check's own verdict — `knowledge`, carrying no execution field, and
 *    absent from {@link executionProviders}, the only set that may close a gap;
 * 2. the run's record — the binding names the skill's role and its content
 *    identity, and the worker's own skill layer actually registers those bytes;
 * 3. the gap — a *name* the capability table does not hold is a gap even though a
 *    knowledge skill of that name sits on disk and the deployment can load it, so
 *    a skill nobody granted a row never counts as a capability.
 *
 * What is real: the store and reducer, admission, the sidecar loader and
 * validator, the run binding and snapshot, the real agent plane behind the spawn,
 * the real `VerifierRegistry`, the real `capability_list`/`task_read` tools, and
 * the filesystem. The model loop is the only thing replaced (the agent factory's
 * `setup`), and a scripted verifier is not used at all: criteria are judged by the
 * real command verifier.
 */

const ROW = 'design-ball'
const SKILL = 's1c-knowledge-fixture'
const ROOT = 's-root' as SessionId
const BODY = 'KNOWLEDGE BODY: ball alignment rules'

afterEach(async () => {
  await disposeRunStacks()
})

function child(objective: string, requiredCapabilities: readonly string[]): DecomposeSpec['children'][number] {
  return {
    objective,
    acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
    requiredCapabilities: requiredCapabilities as string[],
  }
}

describe('a knowledge provider (S1-C)', () => {
  it('is loadable and recorded as knowledge, and never counts as an execution provider', async () => {
    const capabilities: Record<string, CapabilityConfig> = { [ROW]: { skills: [SKILL], tools: ['filesystem'] } }
    const h = await startRunStack({ capabilities, roots: [ROOT], tools: true })
    const directory = await writeKnowledgeSkill(join(h.home, 'skills'), SKILL, BODY)

    const root = await h.root(ROOT)
    const outcomes = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT, {
      reason: 'split the work',
      children: [child('align the ball', [ROW])],
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    // 1. The pre-check's verdict: knowledge, verified content, no execution claim.
    const report = await h.runtime.capabilityProviderReport(ROOT, [ROW])
    const row = report.capabilities.find(item => item.capability === ROW)!
    const verdict = row.skills.find(item => item.name === SKILL)!
    expect(verdict.valid).toBe(true)
    if (!verdict.valid) throw new Error('the row\'s provider was refused')
    expect(verdict.role).toBe('knowledge')
    expect(verdict.directory).toBe(directory)
    expect(verdict.contractDigest).toMatch(/^[0-9a-f]{64}$/)
    // The role is not a label: a knowledge verdict carries no execution field at
    // all, and the only set that may close an execution gap leaves it out.
    expect('verifierRef' in verdict).toBe(false)
    expect('requiredTools' in verdict).toBe(false)
    expect('precondition' in verdict).toBe(false)
    expect(executionProviders(row.skills)).toEqual([])

    // 2. The run's record and the worker's own layer agree with that verdict.
    const run = await h.task.runIn(root.storeId, outcomes[0]!.runId!)
    const binding = run.providerBinding!
    expect(binding.skills).toHaveLength(1)
    expect(binding.skills[0]!.name).toBe(SKILL)
    expect(binding.skills[0]!.role).toBe('knowledge')
    expect(binding.skills[0]!.contractDigest).toBe(verdict.contractDigest)
    expect(binding.skills[0]!.contentDigest).toBe(verdict.contentDigest)
    const worker = h.agent(run.sessionId as SessionId)!
    const registered = await h.ctx.skills.get(SKILL, { scope: worker, cwd: h.checkout })
    expect(registered?.content).toContain(BODY)
    expect(registered!.path!.startsWith(binding.snapshotRoot!)).toBe(true)

    // …and the tool a model reads before dispatching says the same thing.
    const listed = await h.call(worker, 'capability_list', {})
    expect(listed.isError).toBe(false)
    expect(listed.text).toContain(`${SKILL} → knowledge (no execution verifier by design; content: ${verdict.contentDigest.slice(0, 12)})`)
  })

  it('leaves a name the table does not hold a gap, however loadable a knowledge skill of that name is', async () => {
    // Nothing declares SKILL as a capability; the row grants nothing.
    const capabilities: Record<string, CapabilityConfig> = { [ROW]: { tools: ['filesystem'] } }
    const h = await startRunStack({ capabilities, roots: [ROOT], discovery: true })
    await writeKnowledgeSkill(join(h.home, 'skills'), SKILL, BODY)
    // The deployment's own skill service loads it: the skill exists and is
    // readable. What it cannot do is name a capability.
    const loadable = await h.ctx.skills.get(SKILL, { cwd: h.checkout })
    expect(loadable?.content).toContain(BODY)

    const root = await h.root(ROOT)
    const refusal = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT, {
      reason: 'the skill should carry this work',
      children: [child('align the ball', [SKILL])],
    }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))

    // Refused as a capability gap, naming the name the table does not hold.
    expect(String(refusal)).toContain('capability gap')
    expect(String(refusal)).toContain(`[${SKILL}]`)

    // The refusal is the store's own fact, not a return value: the gap is recorded
    // as an obligation, no child task and no run were created, and nothing was
    // spawned — a refused batch never reaches the manifest events of an admitted one.
    expect(h.events(root.storeId).filter(event => event.kind === 'CapabilityGapDetected')).toEqual([])
    const snapshot = await h.snapshot(root.storeId)
    expect(snapshot.tasks.map(task => task.taskId)).toEqual([root.taskId])
    expect(snapshot.obligations).toHaveLength(1)
    expect(snapshot.obligations[0]!.goal).toContain(`capability "${SKILL}"`)
    expect(snapshot.obligations[0]!.criterion).toContain('capability_list shows it')
    expect(h.spawns).toHaveLength(0)
  })
})
