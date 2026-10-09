import { TASK_GUIDANCE } from '../support/skill-roots.ts'
import { describe, expect, test, vi } from 'vitest'
import { join } from 'node:path'
import type { EvidenceBundle, VerificationResult } from '../../../task/src/index.ts'
import { pinSkillHome } from '../support/skill-roots.ts'
import type { DecomposeSpec, ChildOutcome } from '../../src/index.ts'
import { orchestrateEnv } from '../../src/service/env.ts'
import { TaskRuntime, workerBaseline } from '../../src/index.ts'
import { DEFAULT_ALLOW_RUNTIME_DECOMPOSITION, DEFAULT_MAX_CHILDREN, DEFAULT_MAX_DEPTH, DEFAULT_VERIFY_TIMEOUT_MS } from '../../src/config.ts'
import {
  type Harness,
  decomposeAndSettle,
  harness,
  createRoot,
  STORE,
  ROOT_SESSION,
  childSpec,
  runEventKinds,
  taskEvents,
  submitParentResult,
  seedProducer,
  settleRunNested,
} from './orchestrate.fixture.ts'

/**
 * Stand-in for a `leaf` child's own worker deciding the task is not atomic after
 * all: the child itself calls `decomposeAndRun`, exactly as the `task_decompose`
 * tool does (`agent-singularity/src/tools/task-decompose.ts:80`), and whatever
 * admission answers is captured — the children that ran, or the refusal text.
 *
 * Only the root's direct children (depth 1) act, or the grandchildren a granted
 * call creates would split again and the harness would recurse to the depth cap.
 * A deeper session still has to follow the worker protocol — an idle without a
 * submission stays active until its deadline — so it submits and goes idle like the
 * default behaviour does.
 */
function leafWorkerDecomposition(h: Harness, children: DecomposeSpec['children']) {
  const captured: { outcomes?: ChildOutcome[]; refusal?: string } = {}
  h.setIdleBehavior(async sessionId => {
    const bound = await h.runtime.runForSession(sessionId)
    if (bound.task.depth !== 1) {
      await h.runtime.submitResult(sessionId, { summary: 'done' })
      return
    }
    try {
      captured.outcomes = await decomposeAndSettle(h, bound.storeId, bound.task.taskId, bound.run.runId, sessionId, {
        reason: 'the work turned out not to be atomic',
        children,
      })
      // The nested batch ended and handed the run back `active` (K1 §2): the
      // worker's own result is what settles it now — the runtime no longer
      // submits on its behalf, so a worker that stopped here without submitting
      // would remain active until its deadline instead.
      await h.runtime.submitResult(sessionId, { summary: 'the split ran; the work continues under the children' })
      return
    } catch (error) {
      captured.refusal = error instanceof Error ? error.message : String(error)
    }
    // The refusal is what the test is about; the worker still owes the protocol
    // a result, or its run would remain active until its deadline instead of
    // settling the way the test is describing.
    await h.runtime.submitResult(sessionId, { summary: 'the split was refused; the work was done here' })
  })
  return captured
}

describe('TaskRuntime.decomposeAndRun orchestration', () => {
  test('a graph model pin reaches the worker spawn', async () => {
    const h = harness()
    await createRoot(h)
    const graph = await h.graphs.graphForSession(ROOT_SESSION)
    h.graphs.graphForSession.mockResolvedValue({
      ...graph, model: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
    })
    const env = await orchestrateEnv(h.runtime, ROOT_SESSION, 'model-pin')

    await env.spawn({ sessionId: 'child-pinned', name: 'worker', taskWorker: true })

    expect(h.spawned.at(-1)).toMatchObject({
      sessionId: 'child-pinned',
      agentOptions: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
    })
  })

  test('a graph without a pin leaves the worker spawn without agentOptions', async () => {
    const h = harness()
    await createRoot(h)
    const env = await orchestrateEnv(h.runtime, ROOT_SESSION, 'no-pin')

    await env.spawn({ sessionId: 'child-plain', name: 'worker', taskWorker: true })

    expect(h.spawned.at(-1)!.sessionId).toBe('child-plain')
    expect('agentOptions' in h.spawned.at(-1)!).toBe(false)
  })

  test('a frozen run model takes precedence over the graph pin', async () => {
    const h = harness()
    await createRoot(h)
    const graph = await h.graphs.graphForSession(ROOT_SESSION)
    h.graphs.graphForSession.mockResolvedValue({ ...graph, model: { provider: 'p1', model: 'm1' } })
    const env = await orchestrateEnv(h.runtime, ROOT_SESSION, 'frozen')

    await env.spawn({
      sessionId: 'child-bound', name: 'worker', taskWorker: true,
      agentOptions: { provider: 'frozen', model: 'fz' },
    })

    expect(h.spawned.at(-1)!.agentOptions).toEqual({ provider: 'frozen', model: 'fz' })
  })

  test('spawns children in dependency order and records evidence before verified', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b', { dependsOn: [0] }), childSpec('task c', { dependsOn: [0] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified', 'verified'])
    expect(outcomes.every(outcome => outcome.evidenceId !== undefined)).toBe(true)
    expect(h.spawned).toHaveLength(3)

    const snapshot = await h.task.snapshotIn(STORE)
    const sessionOf = (taskId: string) =>
      snapshot.runs.find(run => run.taskId === taskId && run.runId === outcomes.find(o => o.taskId === taskId)?.runId)
        ?.sessionId
    expect(h.spawned[0]!.sessionId).toBe(sessionOf(outcomes[0]!.taskId))
    expect([h.spawned[1]!.sessionId, h.spawned[2]!.sessionId].sort()).toEqual(
      [sessionOf(outcomes[1]!.taskId), sessionOf(outcomes[2]!.taskId)].sort(),
    )
    // A delegated child is a task worker, and the store is where its context
    // comes from (A2): the spawn carries no prompt and no contract text, and the
    // handoff the runtime built for this child is the record the context
    // projection reads back.
    expect(h.spawned[0]!.taskWorker).toBe(true)
    expect(h.spawned[0]!.prompt).toBeUndefined()
    const handoff = (await h.task.snapshotIn(STORE)).handoffs.find(item => item.childTaskId === outcomes[0]!.taskId)
    expect(handoff?.parentObjective).toBe('ship the release')
    expect(handoff?.reasonForDelegation).toBe('split the work')

    for (const outcome of outcomes) {
      expect(runEventKinds(h, outcome.runId!)).toEqual([
        'TaskStarted',
        'TaskVerifying',
        'EvidenceProduced',
        'TaskVerified',
        'ReviewRecorded',
      ])
    }
    const parent = await h.task.taskIn(STORE, rootTaskId)
    expect(parent.decompositionStatus).toBe('decomposed')
    expect(snapshot.edges).toHaveLength(2)
    for (const outcome of outcomes) {
      expect(snapshot.capabilities[outcome.taskId]).toBeDefined()
      const bound = await h.runtime.runForSession(sessionOf(outcome.taskId)!)
      expect(bound.task.taskId).toBe(outcome.taskId)
    }
  })

  test('a failed dependency blocks its dependents while independent siblings still run', async () => {
    const h = harness({ verifier: 'by-objective' })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('fail-me now'), childSpec('downstream', { dependsOn: [0] }), childSpec('independent')],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'blocked', 'verified'])
    // The outcome names the bundle the run produced, whatever the verdict: since
    // A3 one settlement path writes both, so there is no longer a difference
    // between "failed by the verifier" and "failed on adoption".
    expect(outcomes[0]!.evidenceId).toBeDefined()
    expect(outcomes[1]!.runId).toBeUndefined()
    expect(h.spawned).toHaveLength(2)

    const blocked = await h.task.taskIn(STORE, outcomes[1]!.taskId)
    expect(blocked.status).toBe('blocked')
    const blockedEvents = taskEvents(h).filter(
      item => item.kind === 'TaskBlocked' && item.taskId === outcomes[1]!.taskId,
    )
    expect(blockedEvents).toHaveLength(1)
    expect(runEventKinds(h, outcomes[2]!.runId!)).toEqual([
      'TaskStarted',
      'TaskVerifying',
      'EvidenceProduced',
      'TaskVerified',
      'ReviewRecorded',
    ])
  })

  test('the handoff merges declared assumptions with dependency evidence references', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('reference producer'),
        childSpec('downstream', {
          dependsOn: [0],
          assumptions: ['a cycle-accurate reference model exists'],
        }),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    const snapshot = await h.task.snapshotIn(STORE)
    const downstream = snapshot.handoffs.find(item => item.childTaskId === outcomes[1]!.taskId)!
    // The merged assumptions are non-empty and name the dependency's evidence
    // id — the reference truth the downstream criteria may rely on (KISS §5.1).
    const evidenceId = outcomes[0]!.evidenceId!
    expect(downstream.assumptions).toEqual([
      'a cycle-accurate reference model exists',
      `dependency evidence "${evidenceId}" is verified and available as a reference`,
    ])
    expect(downstream.relevantEvidence).toEqual([evidenceId])
    // The dependency-free child gets no derived assumptions.
    expect(snapshot.handoffs.find(item => item.childTaskId === outcomes[0]!.taskId)!.assumptions).toEqual([])
  })

  test('a child whose required artifact is missing never spawns: blocked, named in the record, registered as an obligation', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('rtl implementation', {
          acceptanceCriteria: [
            {
              description: 'cycle-equivalent to the reference on N workloads',
              command: 'true',
              requiresArtifact: ['bemu_trace'],
            },
          ],
        }),
        childSpec('independent'),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['blocked', 'verified'])
    expect(outcomes[0]!.runId).toBeUndefined()
    expect(h.spawned).toHaveLength(1)
    expect((await h.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('blocked')

    const artifactBlocked = taskEvents(h).filter(
      item => item.kind === 'TaskBlocked' && item.taskId === outcomes[0]!.taskId,
    )
    expect(artifactBlocked).toHaveLength(1)
    expect(artifactBlocked[0]!.kind === 'TaskBlocked' ? artifactBlocked[0]!.payload.reason : undefined).toBe(
      'missing required artifacts: bemu_trace (criterion ac1-1)',
    )

    const snapshot = await h.task.snapshotIn(STORE)
    const records = snapshot.reviews.filter(item => item.taskId === outcomes[0]!.taskId)
    expect(records).toHaveLength(1)
    expect(records[0]!.outcome).toBe('blocked')
    expect(records[0]!.runId).toBeUndefined()
    expect(records[0]!.anomalies).toEqual(['missing required artifacts: bemu_trace (criterion ac1-1)'])

    // The missing item is registered as an obligation — a question, not an action.
    expect(snapshot.obligations).toHaveLength(1)
    expect(snapshot.obligations[0]!.goal).toContain('"bemu_trace"')
    expect(snapshot.obligations[0]!.goal).toContain(outcomes[0]!.taskId)
    expect(snapshot.obligations[0]!.criterion).toContain('"bemu_trace"')
    expect(snapshot.obligations[0]!.sourceTaskId).toBe(outcomes[0]!.taskId)
    const obligationEvents = taskEvents(h).filter(item => item.kind === 'ObligationRecorded')
    expect(obligationEvents).toHaveLength(1)
    expect(obligationEvents[0]!.taskId).toBe(outcomes[0]!.taskId)
    // The obligation rides the caller's actor — the same `env.actor` the
    // `TaskBlocked` sibling above is committed with. An actor-less
    // `recordObligationIn` call drops the key from the event envelope entirely,
    // so this equality is what catches that regression.
    expect(obligationEvents[0]!.actor).toBe(ROOT_SESSION)
    expect(obligationEvents[0]!.actor).toBe(artifactBlocked[0]!.actor)

    // The batch ends otherwise, and the parent's own acceptance is its own call
    // (K1 §2): the harness verifier passes the parent's composite criterion
    // unconditionally (the real composite verifier's unverified-child failure is
    // covered in the verifier package's own tests).
    expect(await submitParentResult(h)).toBe('verified')
  })

  test('P4-C: a required artifact from a verified run lets the child run — the stage is legitimately skipped', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    // An upstream product already exists (KISS §5.1): a producer task's
    // verified run recorded evidence carrying the artifact kind before the
    // cascade starts. A `requiresArtifact` reference is a verified reference
    // product, so the producing run's terminal state is part of the match.
    await seedProducer(h, { outcome: 'verified', kind: 'bemu_trace' })

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('rtl implementation', {
          acceptanceCriteria: [
            {
              description: 'cycle-equivalent to the reference on N workloads',
              command: 'true',
              requiresArtifact: ['bemu_trace'],
            },
          ],
        }),
      ],
    })

    expect(outcomes[0]!.status).toBe('verified')
    expect(h.spawned).toHaveLength(1)
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.obligations).toHaveLength(0)
    expect(snapshot.reviews.every(item => item.outcome !== 'blocked')).toBe(true)
  })

  test('a capability-gap rejection registers one obligation per missing capability on the parent', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(
      decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
        reason: 'split the work',
        children: [childSpec('gap child', { requiredCapabilities: ['no-such-cap', 'execute-task'] })],
      }),
    ).rejects.toThrow(/capability gap/)

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.obligations).toHaveLength(1)
    expect(snapshot.obligations[0]!.sourceTaskId).toBe(rootTaskId)
    expect(snapshot.obligations[0]!.goal).toContain('"no-such-cap"')
    expect(snapshot.obligations[0]!.criterion).toContain('"no-such-cap"')
    expect(taskEvents(h).map(item => item.kind)).toContain('ObligationRecorded')
  })

  test('a spawn refusal fails the run with the cause, blocks dependents, and leaves no admitted ghost', async () => {
    const spawnError = 'Unknown agent preset: default'
    const h = harness({ verifier: 'by-objective', spawnError })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h, 'fail-me release')
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('unlucky child'), childSpec('downstream', { dependsOn: [0] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'blocked'])
    expect(h.spawned).toHaveLength(0)

    const cause = `spawn failed: ${spawnError}`
    expect(runEventKinds(h, outcomes[0]!.runId!)).toEqual(['TaskStarted', 'TaskFailed', 'ReviewRecorded'])
    expect(
      taskEvents(h)
        .filter(item => item.kind === 'TaskFailed' && item.runId === outcomes[0]!.runId)
        .map(item => (item.kind === 'TaskFailed' ? item.payload.reason : undefined)),
    ).toEqual([cause])
    expect((await h.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('failed')

    const snapshot = await h.task.snapshotIn(STORE)
    const reviews = snapshot.reviews.filter(item => item.runId === outcomes[0]!.runId)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.outcome).toBe('failed')
    expect(reviews[0]!.localizedCause).toBe(cause)
    expect(reviews[0]!.evidenceRefs).toEqual([])

    expect((await h.task.taskIn(STORE, outcomes[1]!.taskId)).status).toBe('blocked')
    expect(snapshot.tasks.every(task => task.status !== 'admitted')).toBe(true)
    // The child's failure is a fact the parent judges with, never a verdict about
    // the parent: the batch end returns it `active`, and its own submission —
    // judged by the harness verifier, which fails this root's objective — settles
    // it.
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('running')
    expect(await submitParentResult(h)).toBe('failed')
    expect(runEventKinds(h, rootRunId)).toEqual([
      'TaskStarted',
      'TaskVerifying',
      'EvidenceProduced',
      'TaskFailed',
      'ReviewRecorded',
    ])
  })

  test('spawn carries the strictest permission preset the capabilities declare', async () => {
    const h = harness({
      config: {
        capabilities: {
          loose: { skills: ['task-execution'], permission: 'danger-full-access' },
          strict: { skills: ['task-execution'], permission: 'workspace-write' },
        },
      },
    })
    h.ctx.permissionPresets = {
      resolve: (name: string) => {
        const specs: Record<string, { sandbox: string; approval: string }> = {
          'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
          'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
        }
        const spec = specs[name]
        if (spec === undefined)
          throw new Error(`permission: unknown preset "${name}" (known: ${Object.keys(specs).join(', ')})`)
        return spec
      },
    }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('audited child', { requiredCapabilities: ['loose', 'strict'] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]!.permissionPreset).toBe('workspace-write')
  })

  test('spawn omits the permission preset when no capability declares one', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('plain child')],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]!.permissionPreset).toBeUndefined()
  })

  test('spawn carries the grant its manifest resolves to: declared tools and skills, the worker baseline', async () => {
    const home = pinSkillHome('ball-align')
    const h = harness({
      config: { capabilities: { 'design-ball': { skills: ['ball-align'], tools: ['filesystem'] } } },
    })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('ball child', { requiredCapabilities: ['design-ball'] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    expect(h.spawned[0]!.grant).toEqual({
      capabilities: [{ capability: 'design-ball', tools: ['read', 'write', 'edit'], skills: ['ball-align'] }],
      baseline: workerBaseline(),
      keepPresetTools: false,
      // The grant loads this run's own snapshot of the granted skill (S1-C), so
      // the skill layer registers the admitted bytes rather than whatever stands
      // at the production path when the worker starts.
      skillRoots: [join(home, 'singularity', 'run-bindings', STORE, outcomes[0]!.runId!, 'skills')],
    })
    // The prompt's own needs are in the baseline the grant forwards.
    expect(h.spawned[0]!.grant!.baseline).toContain('bash')
    expect(h.spawned[0]!.grant!.baseline).toContain('task_decompose')
  })

  test('spawn declares the child a task worker and carries no contract text of its own', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('ball child')],
    })

    // A2: the spawn seam hands the worker a role marker, not text. The contract
    // the worker reads is the context assembly's `singularity:worker-contract`
    // section, projected from this store at every model request — asserted
    // end-to-end in `tests/integration/context-assembly.spec.ts` — so the
    // runtime keeps exactly one rendering of a contract (its own store records)
    // and the spawn prompt is no longer a second surface a fold can shadow.
    const call = h.spawned[0]!
    expect(call.taskWorker).toBe(true)
    expect(call.prompt).toBeUndefined()
    expect(call.contract).toBeUndefined()

    // The facts that section is projected from are the store's own: the child
    // task's admission-assigned criterion and the command a verifier will run.
    const child = await h.task.taskIn(STORE, outcomes[0]!.taskId)
    expect(child.objective).toBe('ball child')
    expect(child.acceptanceCriteria.map(criterion => [criterion.criterionId, criterion.command])).toEqual([
      ['ac1-1', 'true'],
    ])
  })

  test('a child without guidance is refused before spawn', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('plain child', { requiredCapabilities: [] })],
    })).rejects.toThrow('provide no readable guidance Skill')
    expect(h.spawned).toHaveLength(0)
  })

  test('the preset tool plane stays only for a capability that names its own preset', async () => {
    pinSkillHome('verify')
    const h = harness({
      config: { capabilities: { 'verify-ball-functional': { skills: ['verify'], preset: 'bb-verify' } } },
    })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('verify child', { requiredCapabilities: ['verify-ball-functional'] })],
    })

    expect(h.spawned[0]!.grant!.keepPresetTools).toBe(true)
    expect(h.spawned[0]!.grant!.capabilities).toEqual([
      { capability: 'verify-ball-functional', tools: [], skills: ['verify'] },
    ])
  })

  test('conflicting presets reject the whole batch without persisting or spawning any child', async () => {
    const h = harness({
      config: {
        capabilities: {
          research: { skills: ['task-execution'], preset: 'standard' },
          verify: { preset: 'bb-verify' },
        },
      },
    })
    const { taskId, runId } = await createRoot(h)
    const before = await h.task.snapshotIn(STORE)
    const eventsBefore = taskEvents(h)
    await expect(
      decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
        reason: 'split the work',
        children: [
          childSpec('valid child', { requiredCapabilities: ['research'] }),
          childSpec('conflicting child', { requiredCapabilities: ['research', 'verify'] }),
        ],
      }),
    ).rejects.toThrow(/conflicting capability presets: research -> standard, verify -> bb-verify/)
    expect(h.spawned).toHaveLength(0)
    expect(await h.task.snapshotIn(STORE)).toEqual(before)
    expect(taskEvents(h)).toEqual(eventsBefore)
  })

  test('an unknown tool label rejects the whole batch before anything is persisted or spawned', async () => {
    const h = harness({ config: { capabilities: { typo: { tools: ['filesytem'] } } } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)

    await expect(
      decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
        reason: 'split the work',
        children: [childSpec('typo child', { requiredCapabilities: ['typo'] })],
      }),
    ).rejects.toThrow(/capability "typo" declares unknown tool label "filesytem"; known labels: /)

    expect(h.spawned).toHaveLength(0)
    // Admission rejected before anything was written: the root is still undecomposed and alone in the store.
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.tasks[0]!.decompositionStatus).toBe('decomposable')
    expect((await h.task.taskIn(STORE, rootTaskId)).status).toBe('running')
  })

  test('an unknown capability permission preset fails the run before spawn, naming the preset and capability', async () => {
    const h = harness({ config: { capabilities: { audited: { skills: ['task-execution'], permission: 'nope' } } } })
    h.ctx.permissionPresets = {
      resolve: (name: string) => {
        throw new Error(`permission: unknown preset "${name}" (known: workspace-write, danger-full-access)`)
      },
    }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('audited child', { requiredCapabilities: ['audited'] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed'])
    expect(h.spawned).toHaveLength(0)

    const cause =
      'spawn failed: task-runtime: permission declared by capabilities [audited] is not usable: ' +
      'permission: unknown preset "nope" (known: workspace-write, danger-full-access)'
    expect(runEventKinds(h, outcomes[0]!.runId!)).toEqual(['TaskStarted', 'TaskFailed', 'ReviewRecorded'])
    expect(
      taskEvents(h)
        .filter(item => item.kind === 'TaskFailed' && item.runId === outcomes[0]!.runId)
        .map(item => (item.kind === 'TaskFailed' ? item.payload.reason : undefined)),
    ).toEqual([cause])
    const reviews = (await h.task.snapshotIn(STORE)).reviews.filter(item => item.runId === outcomes[0]!.runId)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.localizedCause).toBe(cause)
  })

  test('a dangling capability preset fails the run before spawn, naming the preset and its capability', async () => {
    const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'ghost' } } } })
    h.ctx.agentPresets = {
      resolve: async (id?: string) => {
        throw new Error(`Unknown agent preset: ${id}`)
      },
    }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('research child', { requiredCapabilities: ['research'] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed'])
    expect(h.spawned).toHaveLength(0)

    const cause =
      'spawn failed: task-runtime: preset "ghost" granted by capabilities [research] is not mountable: Unknown agent preset: ghost'
    expect(runEventKinds(h, outcomes[0]!.runId!)).toEqual(['TaskStarted', 'TaskFailed', 'ReviewRecorded'])
    expect(
      taskEvents(h)
        .filter(item => item.kind === 'TaskFailed' && item.runId === outcomes[0]!.runId)
        .map(item => (item.kind === 'TaskFailed' ? item.payload.reason : undefined)),
    ).toEqual([cause])
    const reviews = (await h.task.snapshotIn(STORE)).reviews.filter(item => item.runId === outcomes[0]!.runId)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.localizedCause).toBe(cause)
  })

  test('a capability gap rejects the whole batch atomically when the child may not decompose', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(
      decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
        reason: 'split the work',
        children: [childSpec('fine'), childSpec('gap child', { requiredCapabilities: ['no-such-cap', 'execute-task'] })],
      }),
    ).rejects.toThrow(/capability gap/)

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
    expect(taskEvents(h).filter(item => item.kind === 'TaskCreated')).toHaveLength(1)
  })

  test('a gap child marked decomposable is admitted as decomposable with CapabilityGapDetected', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('gap child', { requiredCapabilities: ['no-such-cap', 'execute-task'], decomposable: true })],
    })

    expect(outcomes[0]!.status).toBe('verified')
    const child = await h.task.taskIn(STORE, outcomes[0]!.taskId)
    expect(child.decompositionStatus).toBe('decomposable')
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.capabilities[outcomes[0]!.taskId]!.missing).toEqual(['no-such-cap'])
    const kinds = taskEvents(h).map(item => item.kind)
    expect(kinds).toContain('CapabilityGapDetected')
  })

  test('an explicitly decomposable child is admitted as decomposable, with no gap, and told to split further', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('splittable child', { decomposable: true }), childSpec('plain child')],
    })

    const declared = await h.task.taskIn(STORE, outcomes[0]!.taskId)
    const plain = await h.task.taskIn(STORE, outcomes[1]!.taskId)
    expect(declared.decompositionStatus).toBe('decomposable')
    expect(plain.decompositionStatus).toBe('leaf')
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.capabilities[outcomes[0]!.taskId]!.missing).toEqual([])
    expect(snapshot.capabilities[outcomes[0]!.taskId]!.closure).toBe('closed')
    expect(taskEvents(h).map(item => item.kind)).not.toContain('CapabilityGapDetected')

    // The spawn itself says nothing about decomposition any more (A2): which
    // worker is told what is the context projection's conditional part, driven by
    // the task's `decompositionStatus` and the deployment switch
    // (`context/tests/unit/reads.spec.ts` asserts both), while these spawn
    // requests only declare the child a task worker.
    expect(h.spawned[0]!.taskWorker).toBe(true)
    expect(h.spawned[1]!.taskWorker).toBe(true)
    expect(h.spawned[0]!.prompt).toBeUndefined()

    // A declaration is not a gap: with no nested decomposition the child still
    // runs, and the outer cascade verifies it exactly as before.
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    for (const outcome of outcomes) {
      expect(runEventKinds(h, outcome.runId!)).toEqual([
        'TaskStarted',
        'TaskVerifying',
        'EvidenceProduced',
        'TaskVerified',
        'ReviewRecorded',
      ])
    }
  })

  test('a child settled by its own nested decomposition is adopted, not verified a second time', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    h.setIdleBehavior(async sessionId => {
      const bound = await h.runtime.runForSession(sessionId)
      await settleRunNested(h.task, bound.storeId, bound.task.taskId, bound.run.runId, sessionId)
    })

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('splittable child', { decomposable: true }), childSpec('downstream', { dependsOn: [0] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    expect(outcomes[0]!.evidenceId).toBe(`e-nested-${outcomes[0]!.runId}`)

    const nestedRunId = outcomes[0]!.runId!
    const kinds = runEventKinds(h, nestedRunId)
    expect(kinds).toEqual(['TaskStarted', 'TaskVerifying', 'EvidenceProduced', 'TaskVerified', 'ReviewRecorded'])
    expect(kinds.filter(kind => kind === 'TaskVerifying')).toHaveLength(1)
    expect(h.verifier.verifyRun).not.toHaveBeenCalledWith(STORE, nestedRunId, expect.anything())

    expect((await h.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('verified')
    expect((await h.task.runIn(STORE, nestedRunId)).status).toBe('verified')
    // The nested settlement counts as `verified`, so the dependent child still runs.
    expect(runEventKinds(h, outcomes[1]!.runId!)).toEqual([
      'TaskStarted',
      'TaskVerifying',
      'EvidenceProduced',
      'TaskVerified',
      'ReviewRecorded',
    ])
    // The parent's own acceptance is its own submission (K1 §2), and it is the
    // call that consults the harness verifier for this run.
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('running')
    expect(await submitParentResult(h)).toBe('verified')
    expect(h.verifier.verifyRun).toHaveBeenCalledWith(STORE, rootRunId, expect.anything())
  })

  test('a child that settled itself failed is adopted as failed instead of being marked again', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    h.setIdleBehavior(async sessionId => {
      const bound = await h.runtime.runForSession(sessionId)
      await settleRunNested(h.task, bound.storeId, bound.task.taskId, bound.run.runId, sessionId, 'fail')
    })

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('splittable child', { decomposable: true }), childSpec('downstream', { dependsOn: [0] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'blocked'])
    // The adoption reports the bundle the nested settlement produced, and the run
    // is not verified a second time — the one settlement rule A3 gives every
    // terminal run.
    expect(outcomes[0]!.evidenceId).toBe(`e-nested-${outcomes[0]!.runId}`)
    expect(
      (await h.task.snapshotIn(STORE)).evidence
        .filter(item => item.taskRunId === outcomes[0]!.runId)
        .map(item => item.evidenceId),
    ).toEqual([`e-nested-${outcomes[0]!.runId}`])
    expect(runEventKinds(h, outcomes[0]!.runId!)).toEqual([
      'TaskStarted',
      'TaskVerifying',
      'EvidenceProduced',
      'TaskFailed',
      'ReviewRecorded',
    ])
    expect(h.verifier.verifyRun).not.toHaveBeenCalledWith(STORE, outcomes[0]!.runId, expect.anything())
    expect((await h.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('failed')
    expect((await h.task.taskIn(STORE, outcomes[1]!.taskId)).status).toBe('blocked')
  })

  test('structural admission failures persist nothing', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(
      decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
        reason: 'split the work',
        children: [childSpec('cycle a', { dependsOn: [1] }), childSpec('cycle b', { dependsOn: [0] })],
      }),
    ).rejects.toThrow(/cycle/)

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })

  test('refuses a batch above the configured maxChildren, naming the limit, and persists nothing', async () => {
    const h = harness({ config: { maxChildren: 2 } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(
      decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
        reason: 'split the work',
        children: [childSpec('task a'), childSpec('task b'), childSpec('task c')],
      }),
    ).rejects.toThrow(
      /admission rejected decomposition of "[^"]+":\n- task "[^"]+" would have 3 children, above maxChildren 2/,
    )

    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })

  test('admits a batch exactly at the configured maxChildren', async () => {
    const h = harness({ config: { maxChildren: 2 } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b')],
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
  })

  test('refuses a child criterion the shell cannot parse, before any child exists', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(
      decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
        reason: 'split the work',
        children: [
          childSpec('task a'),
          childSpec('task b', {
            acceptanceCriteria: [{ description: 'the answer is balanced', command: 'echo "unclosed' }],
          }),
        ],
      }),
    ).rejects.toThrow(/child 1 criterion .*command has a shell syntax error:/)

    // The batch is refused whole: the parent is still the only task and no worker
    // was ever spawned for a sibling that would have been admitted beside it.
    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })

  test('refuses children that would exceed the configured maxDepth, naming the limit', async () => {
    const h = harness({ config: { maxDepth: 0 } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(
      decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
        reason: 'split the work',
        children: [childSpec('task a')],
      }),
    ).rejects.toThrow(/decomposition refused: depth 0 reaches maxDepth 0/)

    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })

  test('caps an unconfigured deployment at the shipped guardrails: maxDepth 4, maxChildren 8', async () => {
    expect(DEFAULT_MAX_DEPTH).toBe(4)
    expect(DEFAULT_MAX_CHILDREN).toBe(8)
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(
      decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
        reason: 'split the work',
        children: Array.from({ length: 9 }, (_value, index) => childSpec(`task ${index}`)),
      }),
    ).rejects.toThrow(/would have 9 children, above maxChildren 8/)

    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })

  test("a deployment that configures nothing admits a leaf worker's own decomposition: the grandchild verifies and the parent adopts it", async () => {
    expect(DEFAULT_ALLOW_RUNTIME_DECOMPOSITION).toBe(true)
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const nested = leafWorkerDecomposition(h, [childSpec('piece one'), childSpec('piece two', { dependsOn: [0] })])

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('plain child')],
    })

    // The parent predicted one worker and admitted it `leaf`; the node decided
    // otherwise and its own batch was admitted under the same rules.
    const childTaskId = outcomes[0]!.taskId
    const childRunId = outcomes[0]!.runId!
    expect((await h.task.taskIn(STORE, childTaskId)).decompositionStatus).toBe('decomposed')
    expect(nested.refusal).toBeUndefined()
    expect(nested.outcomes!.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    // The worker that split was told it could: the deployment switch is what puts
    // that rule in its assembled contract (`context/tests/unit/reads.spec.ts`:
    // "a leaf worker reads the runtime-split rule … when the deployment admits it").
    // The spawn request carries the role marker and no rendering of the rule.
    expect(h.spawned[0]!.taskWorker).toBe(true)
    expect(h.spawned[0]!.prompt).toBeUndefined()

    const snapshot = await h.task.snapshotIn(STORE)
    const grandchildren = snapshot.tasks.filter(task => task.parentTaskId === childTaskId)
    expect(grandchildren.map(task => [task.depth, task.status])).toEqual([
      [2, 'verified'],
      [2, 'verified'],
    ])
    expect(snapshot.tasks).toHaveLength(4)

    // The nested cascade settled the child's run; the outer round adopts it
    // instead of verifying it a second time.
    expect(outcomes[0]!.status).toBe('verified')
    expect(outcomes[0]!.evidenceId).toBe(`e-${childRunId}`)
    expect(h.verifier.verifyRun).toHaveBeenCalledWith(STORE, childRunId, expect.anything())
    expect(runEventKinds(h, childRunId)).toEqual([
      'TaskStarted',
      'TaskVerifying',
      'EvidenceProduced',
      'TaskVerified',
      'ReviewRecorded',
    ])
    // The root's own acceptance waits for the root's own submission (K1 §2).
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('running')
    expect(await submitParentResult(h)).toBe('verified')
  })

  test('a leaf worker that overreaches is refused by the batch limit, and the refusal names the limit, not the leaf rule', async () => {
    const h = harness({ config: { allowRuntimeDecomposition: true, maxChildren: 2 } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const nested = leafWorkerDecomposition(h, [
      childSpec('piece one'),
      childSpec('piece two'),
      childSpec('piece three'),
    ])

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('plain child')],
    })

    expect(nested.outcomes).toBeUndefined()
    expect(nested.refusal).toMatch(
      /admission rejected decomposition of "[^"]+":\n- task "[^"]+" would have 3 children, above maxChildren 2/,
    )
    expect(nested.refusal).not.toMatch(/admitted as leaf/)
    // Nothing the refused batch planned was persisted, and the child still ran.
    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(2)
    expect(h.spawned).toHaveLength(1)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
  })

  test('with the switch off the same leaf worker is refused and told the switch is what blocked it', async () => {
    const h = harness({ config: { allowRuntimeDecomposition: false } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const nested = leafWorkerDecomposition(h, [childSpec('piece one')])

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('plain child')],
    })

    expect(nested.refusal).toMatch(
      /decomposition refused: task is leaf and runtime decomposition is disabled/,
    )
    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(2)
    expect(h.spawned).toHaveLength(1)
    // Nothing in the spawn invites a split, whatever the switch says (the spawn
    // carries the role marker and no prompt at all) — and the projection the
    // worker reads says nothing about `task_decompose` with the switch off, so the
    // refusal is one it could not have avoided.
    // (`context/tests/unit/reads.spec.ts`: "a leaf worker reads the runtime-split
    // rule … and neither when it does not".)
    expect(h.spawned[0]!.prompt).toBeUndefined()
    expect(h.spawned[0]!.taskWorker).toBe(true)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
  })

  test('cancelBatch cancels the in-flight child, blocks the siblings it never started, and cancels the parent', async () => {
    // One writer at a time: the sibling is the batch's next round, never started,
    // so its block names the in-flight child the cancellation stopped.
    const h = harness({ config: { maxActiveWorkers: 1 } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    // A worker mid-turn: its idle is a promise only the cancellation ends, which
    // is what "in flight" means for the batch.
    h.setIdleBehavior(() => new Promise<void>(() => {}))

    const { batchId } = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b', { dependsOn: [0] })],
    })
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))
    const outcomes = await h.runtime.cancelBatch(STORE, batchId, ROOT_SESSION)

    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled', 'blocked'])
    expect(h.cancelled).toHaveLength(1)
    expect(runEventKinds(h, outcomes[0]!.runId!)).toEqual(['TaskStarted', 'TaskCancelled', 'ReviewRecorded'])
    expect((await h.task.taskIn(STORE, outcomes[0]!.taskId)).status).toBe('cancelled')

    // The child the batch never started has no run to cancel, so it lands as a
    // runless blocked task with its own review record naming the cancellation —
    // never a ghost left admitted for the parent's composite cause to name.
    const neverStarted = outcomes[1]!.taskId
    expect(outcomes[1]!.runId).toBeUndefined()
    expect((await h.task.taskIn(STORE, neverStarted)).status).toBe('blocked')
    const blockedEvents = taskEvents(h).filter(item => item.kind === 'TaskBlocked' && item.taskId === neverStarted)
    expect(blockedEvents).toHaveLength(1)
    expect(blockedEvents[0]!.kind === 'TaskBlocked' ? blockedEvents[0]!.payload.reason : undefined).toBe(
      'cancelled by the caller before this child started',
    )

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks.every(task => task.status !== 'admitted')).toBe(true)
    const runless = snapshot.reviews.filter(item => item.taskId === neverStarted)
    expect(runless).toHaveLength(1)
    expect(runless[0]!.runId).toBeUndefined()
    expect(runless[0]!.outcome).toBe('blocked')
    expect(runless[0]!.anomalies).toEqual(['cancelled by the caller before this child started'])
    expect(runless[0]!.blockedBy).toEqual([{ taskId: outcomes[0]!.taskId, outcome: 'cancelled' }])
    // The batch's parent run is cancelled by the same settlement — the batch is
    // one cancellation, not one per child.
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('cancelled')
    expect((await h.task.taskIn(STORE, rootTaskId)).status).toBe('cancelled')
  })

  test('an already-aborted admission signal persists nothing at all', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const controller = new AbortController()
    controller.abort()

    // The caller's signal governs admission only (A3 §3.7): an aborted one is a
    // batch that was never admitted, so nothing is persisted and the parent stays
    // free to decide again.
    await expect(
      h.runtime.decomposeAndRun(
        STORE,
        rootTaskId,
        rootRunId,
        ROOT_SESSION,
        {
          reason: 'split the work',
          children: [childSpec('task a'), childSpec('task b')],
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/cancelled before anything was persisted/)

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
    expect((await h.task.runIn(STORE, rootRunId)).executionPhase).toBe('active')
  })

  test('a missing verifier fails the submitted run and settles the batch by name instead of rejecting', async () => {
    const h = harness({ config: { maxActiveWorkers: 1 } })
    // The deployment still lists its registry — a contract is admitted against
    // it — but it mounts no verifier able to run one, which is the absence the
    // submission path meets (`orchestrateEnv.verifyRun`'s own named refusal).
    delete (h.ctx.verifier as { verifyRun?: unknown }).verifyRun
    // One writer at a time, so the second child is the next round and never
    // starts: the failure seam blocks it rather than cancelling work in flight.
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    // The submission path is where a missing verifier surfaces now: the worker
    // submits, its run cannot be judged, and the batch's failure seam settles the
    // parent and the children that never started — no rejection to a caller that
    // is no longer waiting (A3 §3.1).
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b')],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'blocked'])
    const snapshot = await h.task.snapshotIn(STORE)
    const started = snapshot.runs.filter(run => run.taskId !== rootTaskId)
    expect(started).toHaveLength(1)
    expect(started[0]!.status).toBe('failed')
    const review = snapshot.reviews.find(item => item.runId === started[0]!.runId)
    expect(review?.localizedCause).toContain('verifier service is not loaded')
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('failed')
    expect((await h.task.taskIn(STORE, outcomes[1]!.taskId)).status).toBe('blocked')
    expect(h.spawned).toHaveLength(1)
  })

  test('runForSession rebuilds its index from a replayed store via the graphs service', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    await Promise.all(h.disposers.map(dispose => dispose()))

    const h2 = harness()
    h2.sessions.clear()
    for (const [id, stored] of h.sessions) h2.sessions.set(id, stored)
    const runtime2 = new TaskRuntime(h2.ctx as never, { capabilities: { ...TASK_GUIDANCE } })
    const childSession = h.spawned[0]!.sessionId
    const bound = await runtime2.runForSession(childSession)
    expect(bound.task.taskId).toBe(outcomes[0]!.taskId)
    expect(bound.run.sessionId).toBe(childSession)
    expect(h2.graphs.graphForSession).toHaveBeenCalled()
    await expect(runtime2.runForSession('unknown-session')).rejects.toThrow(/no task run/)
  })

  test('passes the graph env checkout path as cwd to the verifier', async () => {
    const h = harness()
    h.ctx.envBuilder = { store: { get: (envId: string) => ({ path: `/fake/env/${envId}` }) } }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    expect(h.verifier.verifyRun).toHaveBeenCalledWith(STORE, expect.any(String), {
      cwd: '/fake/env/env1',
      timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    })
  })

  test('omits cwd when the env path cannot be resolved', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    expect(h.verifier.verifyRun).toHaveBeenCalledWith(STORE, expect.any(String), {
      timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    })
  })

  test('binds capability-granted MCP servers onto the spawn grant, resolved against the graph env', async () => {
    pinSkillHome('check')
    const h = harness({
      config: { capabilities: { 'check-ball-registration': { skills: ['check'], mcpServers: ['bbdev'] } } },
    })
    h.ctx.envBuilder = {
      store: {
        get: (envId: string) => ({
          path: `/fake/env/${envId}`,
          components: [{ owner: 'fork', repo: 'buckyball', url: 'u', dir: 'fork/buckyball', status: 'ready' }],
        }),
      },
    }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('check the registration', { requiredCapabilities: ['check-ball-registration'] })],
    })
    expect(outcomes[0]!.status).toBe('verified')
    const grant = h.spawned[0]!.grant!
    expect(grant.capabilities).toEqual([{ capability: 'check-ball-registration', tools: [], skills: ['check'] }])
    expect(grant.mcpServers).toEqual([
      {
        serverName: 'bbdev',
        command: '/fake/env/env1/fork/buckyball/scripts/claude/run_mcp_server.sh',
        args: [],
        env: {},
        cwd: '/fake/env/env1/fork/buckyball',
      },
    ])
    // the run record carries the mcp marker alongside the granted skill
    const run = await h.task.runIn(STORE, outcomes[0]!.runId!)
    expect(run.capabilitySnapshot).toEqual(['check', 'mcp:bbdev'])
  })

  test('a capability-granted MCP server with no env binding fails the spawn loudly and settles the run failed', async () => {
    pinSkillHome('check')
    const h = harness({
      config: { capabilities: { 'check-ball-registration': { skills: ['check'], mcpServers: ['bbdev'] } } },
    })
    // no envBuilder in the context: the binding resolves to undefined
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('check the registration', { requiredCapabilities: ['check-ball-registration'] })],
    })
    expect(outcomes[0]!.status).toBe('failed')
    expect(h.spawned).toHaveLength(0)
    const task = await h.task.taskIn(STORE, outcomes[0]!.taskId)
    expect(task.status).toBe('failed')
    const snapshot = await h.task.snapshotIn(STORE)
    const record = snapshot.reviews.find(item => item.taskId === outcomes[0]!.taskId)
    expect(record!.localizedCause).toContain('spawn failed: task-runtime: MCP server "bbdev" needs an env binding')
  })

  test('an env without the bound repo fails the spawn, naming the repo and the env root', async () => {
    const h = harness({ config: { capabilities: { 'check-ball-registration': { skills: ['task-execution'], mcpServers: ['bbdev'] } } } })
    h.ctx.envBuilder = { store: { get: (envId: string) => ({ path: `/fake/env/${envId}`, components: [] }) } }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('check the registration', { requiredCapabilities: ['check-ball-registration'] })],
    })
    expect(outcomes[0]!.status).toBe('failed')
    const snapshot = await h.task.snapshotIn(STORE)
    const record = snapshot.reviews.find(item => item.taskId === outcomes[0]!.taskId)
    expect(record!.localizedCause).toContain(
      'binds {repoRoot:buckyball} but this run\'s env (/fake/env/env1) has no "buckyball" checkout',
    )
  })

  test('a capability without MCP servers never consults the env binding', async () => {
    pinSkillHome('ball-align')
    const h = harness({ config: { capabilities: { 'design-ball': { skills: ['ball-align'] } } } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a', { requiredCapabilities: ['design-ball'] })],
    })
    expect(outcomes[0]!.status).toBe('verified')
    expect(h.spawned[0]!.grant!.mcpServers).toBeUndefined()
  })

  test("hands the configured verify deadline down as the verifier's own timeout", async () => {
    const h = harness({ config: { verifyTimeoutMs: 1234 } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    expect(h.verifier.verifyRun).toHaveBeenCalledWith(STORE, expect.any(String), { timeoutMs: 1234 })
  })

  test("a batch end hands the parent back active; the parent's own submission is what its verifier judges", async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a'), childSpec('task b')],
    })
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])

    // The batch ended and gave execution back: the run is active, nothing is
    // submitted, and the children's facts are in the store.
    const handedBack = await h.task.runIn(STORE, rootRunId)
    expect(handedBack.executionPhase).toBe('active')
    expect(handedBack.batchId).toBeUndefined()
    expect(handedBack.status).toBe('running')
    expect(handedBack.submission).toBeUndefined()
    expect((await h.task.taskIn(STORE, rootTaskId)).status).not.toBe('verified')
    expect(h.relayed.filter(item => item.sessionId === ROOT_SESSION)).toHaveLength(1)
    expect(h.relayed[0]!.messageId).toBe(`m-batchend-${handedBack.batches![0]!.batchId}`)
    expect(h.relayed[0]!.text).toContain('task_submit_result')
    expect(h.runtime.gate.phaseOf(ROOT_SESSION)).toBe('active')
    expect(runEventKinds(h, rootRunId)).toEqual(['TaskStarted'])

    // Only the parent's own result starts its acceptance, and it is judged by
    // the same verifier as before.
    expect(await submitParentResult(h)).toBe('verified')
    expect((await h.task.taskIn(STORE, rootTaskId)).status).toBe('verified')
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.evidence.some(item => item.taskRunId === rootRunId)).toBe(true)
    expect(runEventKinds(h, rootRunId)).toEqual([
      'TaskStarted',
      'TaskVerifying',
      'EvidenceProduced',
      'TaskVerified',
      'ReviewRecorded',
    ])
  })

  test('fails the parent run when the verdict on its own criteria fails', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const childVerdict = h.verifier.verifyRun.getMockImplementation()!
    h.verifier.verifyRun.mockImplementation(async (storeId: string, runId: string) => {
      if (runId !== rootRunId) return childVerdict(storeId, runId)
      const parent = await h.task.taskIn(storeId, rootTaskId)
      const verifierResults: VerificationResult[] = parent.acceptanceCriteria.map(criterion => ({
        criterionId: criterion.criterionId,
        status: 'fail' as const,
        verifierId: 'fake-verifier',
      }))
      const bundle: EvidenceBundle = {
        evidenceId: `e-${runId}`,
        taskRunId: runId,
        taskId: rootTaskId,
        artifacts: [],
        verifierResults,
        claims: verifierResults.map(result => ({
          claimId: `claim-${result.criterionId}`,
          criterionId: result.criterionId,
          status: result.status,
          verifierId: result.verifierId,
          artifactRefs: [],
        })),
        generatedAt: new Date().toISOString(),
      }
      await h.task.recordEvidenceIn(storeId, bundle, 'fake-verifier')
      return bundle
    })

    await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })

    // A verified child says nothing about the parent's own criteria: the run is
    // active until the parent hands its result in, and that verdict is what
    // fails it here.
    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('running')
    expect(await submitParentResult(h)).toBe('failed')
    expect((await h.task.taskIn(STORE, rootTaskId)).status).toBe('failed')
    expect(runEventKinds(h, rootRunId)).toEqual([
      'TaskStarted',
      'TaskVerifying',
      'EvidenceProduced',
      'TaskFailed',
      'ReviewRecorded',
    ])
  })

  test('names the unmet criterion and what the verifier said about it in the failure reason', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const original = h.verifier.verifyRun.getMockImplementation()!
    h.verifier.verifyRun.mockImplementation(async (storeId: string, runId: string) => {
      if (runId === rootRunId) return original(storeId, runId)
      const run = await h.task.runIn(storeId, runId)
      const instance = await h.task.taskIn(storeId, run.taskId)
      const verifierResults: VerificationResult[] = instance.acceptanceCriteria.map(criterion => ({
        criterionId: criterion.criterionId,
        status: 'inconclusive' as const,
        verifierId: 'fake-verifier',
        details: 'timeout after 600000ms',
      }))
      const bundle: EvidenceBundle = {
        evidenceId: `e-${runId}`,
        taskRunId: runId,
        taskId: instance.taskId,
        artifacts: [],
        verifierResults,
        claims: verifierResults.map(result => ({
          claimId: `claim-${result.criterionId}`,
          criterionId: result.criterionId,
          status: result.status,
          verifierId: result.verifierId,
          artifactRefs: [],
        })),
        generatedAt: new Date().toISOString(),
      }
      await h.task.recordEvidenceIn(storeId, bundle, 'fake-verifier')
      return bundle
    })

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })

    expect(outcomes[0]!.status).toBe('failed')
    expect(
      taskEvents(h)
        .filter(item => item.kind === 'TaskFailed' && item.runId === outcomes[0]!.runId)
        .map(item => (item.kind === 'TaskFailed' ? item.payload.reason : undefined)),
    ).toEqual(['mandatory criteria not satisfied: ac1-1 inconclusive (timeout after 600000ms)'])
  })

  test('a verification that times out fails its run once and no late verdict can land on it', async () => {
    const h = harness({ verifier: 'timeout' })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })

    const childRunId = outcomes[0]!.runId!
    expect(outcomes[0]!.status).toBe('failed')
    expect((await h.task.runIn(STORE, childRunId)).status).toBe('failed')
    expect(runEventKinds(h, childRunId)).toEqual(['TaskStarted', 'TaskVerifying', 'TaskFailed', 'ReviewRecorded'])
    expect((await h.task.snapshotIn(STORE)).evidence.filter(item => item.taskRunId === childRunId)).toHaveLength(0)
    expect(
      taskEvents(h)
        .filter(item => item.kind === 'TaskFailed' && item.runId === childRunId)
        .map(item => (item.kind === 'TaskFailed' ? item.payload.reason : undefined)),
    ).toEqual([
      `task-runtime: verification of run "${childRunId}" timed out after 615000ms (verifier deadline 600000ms + 15000ms safety margin)`,
    ])

    // The abandoned verification is not gone: it settles late, carrying a pass
    // for a run that is already failed. The store refuses it, so the evidence
    // trail can never contradict the run's terminal state.
    const criterionId = (await h.task.taskIn(STORE, outcomes[0]!.taskId)).acceptanceCriteria[0]!.criterionId
    const late: EvidenceBundle = {
      evidenceId: 'late-evidence',
      taskRunId: childRunId,
      taskId: outcomes[0]!.taskId,
      artifacts: [],
      verifierResults: [{ criterionId, status: 'pass', verifierId: 'fake-verifier', exitCode: 0 }],
      claims: [],
      generatedAt: new Date().toISOString(),
    }
    await expect(h.task.recordEvidenceIn(STORE, late, 'fake-verifier')).rejects.toThrow(
      `task: run "${childRunId}" is failed; evidence can only be recorded while the run is running`,
    )
    expect((await h.task.snapshotIn(STORE)).evidence.filter(item => item.taskRunId === childRunId)).toHaveLength(0)
    expect((await h.task.runIn(STORE, childRunId)).status).toBe('failed')
    expect(runEventKinds(h, childRunId)).toEqual(['TaskStarted', 'TaskVerifying', 'TaskFailed', 'ReviewRecorded'])
  })

  test('cancelGraph records cancellation when the worker is still spawning', async () => {
    const h = harness()
    const { taskId, runId } = await createRoot(h)
    const spawning = Promise.withResolvers<void>()
    vi.spyOn(h.runtime.context.agentRuntime, 'spawn').mockImplementation((_parent, request) =>
      new Promise<never>((_resolve, reject) => {
        request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true })
        spawning.resolve()
      }),
    )
    await h.runtime.decomposeAndRun(STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work', children: [childSpec('child still spawning')],
    })
    await spawning.promise

    await h.runtime.cancelGraph(STORE, 'cancel during spawn')

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.runs.map(run => run.status)).toEqual(['cancelled', 'cancelled'])
    expect(snapshot.reviews.map(review => review.outcome)).toEqual(['cancelled', 'cancelled'])
  })

  test('cancelGraph settles the parent run and every session of the store', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    // A worker mid-turn: the graph cancellation has to stop it, settle it, and
    // settle the parent that was waiting on it (A3 §3.6).
    h.setIdleBehavior(() => new Promise<void>(() => {}))

    const { batchId } = await h.runtime.decomposeAndRun(STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('task a')],
    })
    await vi.waitFor(() => expect(h.spawned).toHaveLength(1))
    const childSession = h.spawned[0]!.sessionId

    await h.runtime.cancelGraph(STORE, 'graph removed')
    // Idempotent: the second call has nothing left to do and must not throw.
    await h.runtime.cancelGraph(STORE, 'graph removed')

    expect((await h.task.runIn(STORE, rootRunId)).status).toBe('cancelled')
    expect(runEventKinds(h, rootRunId)).toEqual(['TaskStarted', 'TaskCancelled', 'ReviewRecorded'])
    const snapshot = await h.task.snapshotIn(STORE)
    const child = snapshot.tasks.find(task => task.taskId !== rootTaskId)!
    expect(child.status).toBe('cancelled')
    // The gate is closed for every session the store owns, so a late write from
    // either session is denied (the tool-gate wiring itself is the runtime
    // integration's; this is the phase bookkeeping it reads).
    await expect(h.runtime.cancelBatch(STORE, batchId, ROOT_SESSION)).rejects.toThrow(/not in flight/)
    void childSession
  })
})
