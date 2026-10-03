import { describe, expect, test } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EvidenceBundle, VerificationResult } from '../../../task/src/index.ts'
import { pinSkillHome } from '../support/skill-roots.ts'
import { DEFAULT_BUDGET, VerifierUnavailableError, escalationHint } from '../../src/index.ts'
import {
  harness,
  createRoot,
  decomposeAndSettle,
  STORE,
  ROOT_SESSION,
  childSpec,
  createAcceptanceParent,
  submitParentResult,
  taskEvents,
  seedProducer,
} from './orchestrate.fixture.ts'

/**
 * The content a run is bound to and loads (S1-C stage 3). The claim under test
 * has three parts, and each is asserted where it can be observed: the *record*
 * (read back from the store, not off the writer), the *bytes* (read from the
 * snapshot directory the record names), and the *grant* (the spawn request the
 * worker's skill layer is built from). A run that only recorded a digest while
 * the worker still loaded a mutable production path would pass the first and
 * fail the others.
 */
describe('the content a run is bound to (S1-C)', () => {
  /** The production `SKILL.md` the pinned skill home holds, as the admission pre-check read it. */
  function productionSkill(home: string, name = 'ball-align'): string {
    return join(home, 'skills', name, 'SKILL.md')
  }

  test('a child run records the provider identity it was admitted under and loads its own snapshot of the bytes', async () => {
    const home = pinSkillHome('ball-align')
    const h = harness({ config: { capabilities: { 'design-ball': { skills: ['ball-align'] } } } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('ball child', { requiredCapabilities: ['design-ball'] })],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    const run = await h.task.runIn(STORE, outcomes[0]!.runId!)
    const binding = run.providerBinding
    if (binding === undefined) throw new Error('the run recorded no provider binding')
    expect(binding.registryRevision).toMatch(/^[0-9a-f]{64}$/)
    expect(binding.mcpServers).toEqual([])
    expect(binding.snapshotRoot).toBe(join(home, 'singularity', 'run-bindings', STORE, run.runId, 'skills'))
    expect(binding.skills).toHaveLength(1)
    const skill = binding.skills[0]!
    expect(skill.name).toBe('ball-align')
    expect(skill.role).toBe('guidance')
    expect(skill.capabilities).toEqual(['design-ball'])
    expect(skill.description).toContain('Align a Buckyball Ball')
    expect(skill.contractDigest).toBeNull()
    expect(skill.uncovered).toEqual([])
    expect(skill.contentDigest).toMatch(/^[0-9a-f]{64}$/)

    // The bytes: the snapshot holds the admitted content, not a copy made later.
    const admitted = await readFile(productionSkill(home), 'utf8')
    const snapshot = await readFile(join(binding.snapshotRoot!, 'ball-align', 'SKILL.md'), 'utf8')
    expect(snapshot).toBe(admitted)
    // And the record's own digests describe those bytes: re-reading the snapshot
    // through the runtime reports nothing wrong with it, which is the check a
    // later reader (and `task_read`) performs before trusting the record.
    expect((await h.runtime.readRunBinding(binding))?.defects).toEqual([])

    // The grant: the worker's skill layer is built from the snapshot root.
    expect(h.spawned[0]!.grant!.skillRoots).toEqual([binding.snapshotRoot])

    // The worker's capability names ride its assembled contract, rendered from
    // this same record by the context projection (`context/src/run-binding.ts`,
    // asserted in `context/tests/unit/run-binding.spec.ts` and end-to-end in
    // `tests/integration/context-assembly.spec.ts`); the spawn request itself
    // carries only the role marker.
    expect(binding.capabilities).toContain('design-ball')
    expect(binding.skills.map(skill => skill.name)).toContain('ball-align')
    expect(h.spawned[0]!.taskWorker).toBe(true)
    expect(h.spawned[0]!.prompt).toBeUndefined()
  })

  test("a production rewrite after the run was bound leaves the run's bytes alone, and the next run binds the new bytes", async () => {
    const home = pinSkillHome('ball-align')
    const h = harness({ config: { capabilities: { 'design-ball': { skills: ['ball-align'] } } } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const first = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('first ball child', { requiredCapabilities: ['design-ball'] })],
    })
    const firstBinding = (await h.task.runIn(STORE, first[0]!.runId!)).providerBinding!
    const firstBytes = await readFile(join(firstBinding.snapshotRoot!, 'ball-align', 'SKILL.md'), 'utf8')

    // The evolution-apply shape: the production file is rewritten under a
    // running system. The bound run's snapshot is untouched…
    await writeFile(productionSkill(home), '---\nname: ball-align\ndescription: rewritten purpose\n---\n\nnew body\n')
    expect(await readFile(join(firstBinding.snapshotRoot!, 'ball-align', 'SKILL.md'), 'utf8')).toBe(firstBytes)

    // …and a run admitted afterwards binds the new bytes, recording its own
    // identity: a version change is a new run, never a hot swap of an old one.
    // (A parent decomposes once, so the new admission belongs to its own store —
    // the same deployment, the same pinned skill home.)
    const next = harness({ config: { capabilities: { 'design-ball': { skills: ['ball-align'] } } } })
    const secondRoot = await createRoot(next)
    const second = await decomposeAndSettle(next, STORE, secondRoot.taskId, secondRoot.runId, ROOT_SESSION, {
      reason: 'split the work again',
      children: [childSpec('second ball child', { requiredCapabilities: ['design-ball'] })],
    })
    expect(second[0]!.status).toBe('verified')
    const secondBinding = (await next.task.runIn(STORE, second[0]!.runId!)).providerBinding!
    expect(secondBinding.snapshotRoot).not.toBe(firstBinding.snapshotRoot)
    expect(secondBinding.skills[0]!.contentDigest).not.toBe(firstBinding.skills[0]!.contentDigest)
    expect(await readFile(join(secondBinding.snapshotRoot!, 'ball-align', 'SKILL.md'), 'utf8')).toContain('new body')
    expect(next.spawned[0]!.grant!.skillRoots).toEqual([secondBinding.snapshotRoot])
  })

  test('a provider whose bytes moved between admission and the run fails that run by name, with no worker spawned', async () => {
    const home = pinSkillHome('ball-align')
    const h = harness({ config: { capabilities: { 'design-ball': { skills: ['ball-align'] } } } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    // The window is real: the batch is admitted once, and a later child's run
    // starts only after its dependency settled. The production file moves inside
    // that window, so the bytes the admission judged are gone by the time the
    // second run would bind them.
    h.setIdleBehavior(async sessionId => {
      if (sessionId === h.spawned[0]?.sessionId) {
        await writeFile(
          productionSkill(home),
          '---\nname: ball-align\ndescription: rewritten during the batch\n---\n\nreplaced\n',
        )
      }
      // Whatever the override does, the worker protocol still applies: the run
      // has to be submitted to reach a terminal state.
      await h.runtime.submitResult(sessionId, { summary: 'done' })
    })
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('first ball child', { requiredCapabilities: ['design-ball'] }),
        childSpec('second ball child', { requiredCapabilities: ['design-ball'], dependsOn: [0] }),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'failed'])
    // One worker: the second run never reached the spawn.
    expect(h.spawned).toHaveLength(1)
    const snapshot = await h.task.snapshotIn(STORE)
    const failedRun = snapshot.runs.find(run => run.taskId === outcomes[1]!.taskId)!
    expect(failedRun.status).toBe('failed')
    // Nothing is bound by a run that loaded nothing: the failure is named, and
    // the record does not claim content it never materialized.
    expect(failedRun.providerBinding).toBeUndefined()
    const record = snapshot.reviews.find(item => item.taskId === outcomes[1]!.taskId)!
    expect(record.localizedCause).toContain('content binding failed')
    expect(record.localizedCause).toContain('ball-align')
    expect(record.localizedCause).toContain('SKILL.md')
    expect(record.localizedCause).toContain('not the admitted content')
    // Nothing spawned a worker, and nothing was left claiming to have loaded.
    expect(snapshot.evidence.filter(item => item.taskRunId === failedRun.runId)).toEqual([])
    expect(record.outcome).toBe('failed')
  })

  test('the run record groups every matched capability with the providers the admission selected', async () => {
    pinSkillHome('ball-align', 'check')
    const h = harness({
      config: {
        capabilities: {
          'design-ball': { skills: ['ball-align'] },
          'check-ball-registration': { skills: ['check'] },
          research: { tools: ['filesystem'] },
        },
      },
    })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('ball child', { requiredCapabilities: ['design-ball', 'check-ball-registration', 'research'] }),
      ],
    })

    // The record, not a rendering of it: what the worker's assembled contract is
    // projected from is this run's own binding, and the text that projects it is
    // the context package's (`context/src/run-binding.ts`, asserted in
    // `context/tests/unit/run-binding.spec.ts`).
    const binding = (await h.task.runIn(STORE, outcomes[0]!.runId!)).providerBinding
    if (binding === undefined) throw new Error('the run recorded no provider binding')
    // Every capability the run matched is in the record, including the row that
    // carries no provider skill (its tools are granted without one) and the rows
    // whose skills this deployment pinned — a worker never has to guess a
    // capability name to decompose or delegate.
    expect(binding.capabilities).toEqual(expect.arrayContaining(['design-ball', 'check-ball-registration', 'research']))
    expect(binding.skills.map(skill => [skill.name, skill.role])).toEqual([
      ['ball-align', 'guidance'],
      ['check', 'guidance'],
    ])
    expect(binding.skills.find(skill => skill.name === 'ball-align')?.capabilities).toEqual(['design-ball'])
    // Identity and purpose only: the body is never stored in the record — the
    // worker reads it with the `skill` tool from the snapshot the record names.
    for (const skill of binding.skills)
      expect(JSON.stringify(skill)).not.toContain('Align a Buckyball Ball across layers')
    expect(binding.snapshotRoot).toBeDefined()
  })
})

describe('TaskRuntime parent acceptance and evidence identity (P4)', () => {
  test('P4-A: a parent AC with a complete childEvidence map verifies once every child verified', async () => {
    const h = harness({ verifier: 'real-composite' })
    const { taskId, runId } = await createAcceptanceParent(h, [
      {
        criterionId: 'root-combination',
        description: 'the children together prove the root goal',
        verificationMode: 'composite',
        requiredEvidence: [],
        mandatory: true,
        childEvidence: [{ childIndex: 0, criterionId: 'ac1-1' }, { childIndex: 1 }],
      },
    ])

    const outcomes = await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child a'), childSpec('child b')],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    // The map is judged against the parent's *own* submission (K1 §2), which is
    // also where the run-level `childIndex` resolution happens.
    expect(await submitParentResult(h)).toBe('verified')
    expect((await h.task.taskIn(STORE, taskId)).status).toBe('verified')
  })

  test('P4-B: a map pointing at a criterion no child has fails the parent, naming the missing item', async () => {
    const h = harness({ verifier: 'real-composite' })
    const { taskId, runId } = await createAcceptanceParent(h, [
      {
        criterionId: 'root-combination',
        description: 'the children together prove the root goal',
        verificationMode: 'composite',
        requiredEvidence: [],
        mandatory: true,
        childEvidence: [{ childIndex: 0, criterionId: 'ac1-9' }],
      },
    ])

    const outcomes = await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child a'), childSpec('child b')],
    })

    // Every child verified — the conjunction alone would have passed the parent,
    // and the parent's own submission is what fails it.
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    expect(await submitParentResult(h)).toBe('failed')
    expect((await h.task.taskIn(STORE, taskId)).status).toBe('failed')
    const failed = taskEvents(h).find(item => item.kind === 'TaskFailed' && item.taskId === taskId)
    const reason = failed?.kind === 'TaskFailed' ? failed.payload.reason : undefined
    expect(reason).toContain('root-combination')
    expect(reason).toContain('ac1-9')
  })

  test('P4-C: a same-named product from a failed run does not satisfy requiresArtifact', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await seedProducer(h, { outcome: 'failed', kind: 'bemu_trace' })

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

    expect(outcomes.map(outcome => outcome.status)).toEqual(['blocked'])
    expect(outcomes[0]!.runId).toBeUndefined()
    expect(h.spawned).toHaveLength(0)
    const blocked = taskEvents(h).find(item => item.kind === 'TaskBlocked' && item.taskId === outcomes[0]!.taskId)
    expect(blocked?.kind === 'TaskBlocked' ? blocked.payload.reason : undefined).toBe(
      'missing required artifacts: bemu_trace (criterion ac1-1)',
    )
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.obligations).toHaveLength(1)
    expect(snapshot.obligations[0]!.goal).toContain('"bemu_trace"')
    expect(snapshot.obligations[0]!.criterion).toContain('verified run')
  })

  test('P4-C: acceptsArtifact names a raw input — a product from any run state satisfies it', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await seedProducer(h, { outcome: 'failed', kind: 'bemu_trace' })

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('rtl implementation', {
          acceptanceCriteria: [
            {
              description: 'consumes the golden trace as a raw input',
              command: 'true',
              acceptsArtifact: ['bemu_trace'],
            },
          ],
        }),
        // The raw-input expression is still an existence check: a reference no
        // run ever produced blocks the same way a missing one always did.
        childSpec('dependent consumer', {
          acceptanceCriteria: [
            {
              description: 'consumes a trace nobody produced',
              command: 'true',
              acceptsArtifact: ['absent_trace'],
            },
          ],
        }),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'blocked'])
    expect(h.spawned).toHaveLength(1)
    const blocked = taskEvents(h).find(item => item.kind === 'TaskBlocked' && item.taskId === outcomes[1]!.taskId)
    expect(blocked?.kind === 'TaskBlocked' ? blocked.payload.reason : undefined).toBe(
      'missing required artifacts: absent_trace (criterion ac2-1; raw input, any run state)',
    )
  })

  test('P4-D: a heuristic criterion is not counted as a deterministic pass even when the verdict is pass', async () => {
    const h = harness()
    const { taskId, runId } = await createAcceptanceParent(h, [
      {
        criterionId: 'root-heuristic',
        description: 'the combination reads as correct to a reviewer',
        verificationMode: 'composite',
        requiredEvidence: [],
        mandatory: true,
        heuristic: true,
      },
    ])

    const outcomes = await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child a')],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
    // The child verified and the harness verifier passed the parent's
    // criterion; the heuristic label is the only thing standing between that
    // verdict and a deterministic pass — and it holds across the parent's own
    // submission (K1 §2).
    expect(await submitParentResult(h)).toBe('failed')
    expect((await h.task.taskIn(STORE, taskId)).status).toBe('failed')
    const failed = taskEvents(h).find(item => item.kind === 'TaskFailed' && item.taskId === taskId)
    const reason = failed?.kind === 'TaskFailed' ? failed.payload.reason : undefined
    expect(reason).toContain('root-heuristic')
    expect(reason).toContain('heuristic')
  })

  test('P4-D: the same parent without the heuristic label verifies — the default is unchanged', async () => {
    const h = harness()
    const { taskId, runId } = await createAcceptanceParent(h, [
      {
        criterionId: 'root-combination',
        description: 'all mandatory children verified',
        verificationMode: 'composite',
        requiredEvidence: [],
        mandatory: true,
      },
    ])

    await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child a')],
    })

    expect(await submitParentResult(h)).toBe('verified')
    expect((await h.task.taskIn(STORE, taskId)).status).toBe('verified')
  })

  test('P4-E: a child requiring independent acceptance without a map is refused at admission and persists nothing', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(
      decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
        reason: 'split the work',
        children: [childSpec('child a', { requiresIndependentAcceptance: true })],
      }),
    ).rejects.toThrow(/requires independent parent acceptance/)

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })

  test('P4-E: a tampered (malformed) childEvidence map is refused at admission and persists nothing', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(
      decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
        reason: 'split the work',
        children: [
          childSpec('child a', {
            acceptanceCriteria: [
              { description: 'the child works', command: 'true', childEvidence: [{ childIndex: -1 }] },
            ],
          }),
        ],
      }),
    ).rejects.toThrow(/childEvidence/)

    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })
})

describe('TaskRuntime budget (KISS §5, VRTC plan 1.3)', () => {
  test('an unconfigured deployment resolves the shipped budget defaults', () => {
    expect(DEFAULT_BUDGET).toEqual({ maxToolCalls: 150, attempts: 1 })
    const h = harness()
    expect(h.runtime.budget).toEqual(DEFAULT_BUDGET)

    expect(() => harness({ config: { budget: { wallTimeMs: 1000 } } as never })).toThrow(
      'unsupported fields [wallTimeMs]',
    )
    expect(() => harness({ config: { rootBudget: { wallTimeMs: 1000 } } as never })).toThrow(
      'rootBudget names [wallTimeMs]',
    )
  })

  test('a tool-call count over budget is annotated post-hoc on the terminal record; the verdict stands', async () => {
    const h = harness({ config: { budget: { maxToolCalls: 2 } } })
    // The session log exists only once the run settled — that is exactly why
    // this budget member is a post-hoc check and not in-flight enforcement.
    h.ctx.sessionQuery = {
      readSession: async (sessionId: string) => ({
        events:
          sessionId === ROOT_SESSION
            ? []
            : Array.from({ length: 3 }, (_value, index) => ({
                type: 'tool/call',
                data: { name: 'bash', callId: `c${index}` },
              })),
      }),
    }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('chatty child')],
    })

    expect(outcomes[0]!.status).toBe('verified')
    const snapshot = await h.task.snapshotIn(STORE)
    const record = snapshot.reviews.find(item => item.runId === outcomes[0]!.runId)!
    expect(record.anomalies).toEqual([
      `budget exceeded: maxToolCalls (observed 3 tool calls over the limit 2; post-hoc check at terminal time — the run was not stopped in flight) — ${escalationHint(
        'the run already spent more tool calls than its budget allows',
        'the run finished before the breach was observable',
        'raise the budget, split the task, or accept the overspend',
      )}`,
    ])
    // The root session's own log is empty, so the parent's own record — written
    // when the parent submits its result (K1 §2) — stays clean.
    expect(await submitParentResult(h)).toBe('verified')
    expect((await h.task.snapshotIn(STORE)).reviews.find(item => item.runId === rootRunId)!.anomalies).toEqual([])
  })

  test('a token total over budget is annotated post-hoc and named session-scoped', async () => {
    const h = harness({ config: { budget: { tokens: 100 } } })
    h.ctx.sessions = { get: (sessionId: string) => ({ id: sessionId }) }
    h.ctx.sessionProjections = {
      snapshot: () => ({
        values: { tokenUsage: { uncachedInputTokens: 60, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      }),
    }
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('hungry child')],
    })

    expect(outcomes[0]!.status).toBe('verified')
    const record = (await h.task.snapshotIn(STORE)).reviews.find(item => item.runId === outcomes[0]!.runId)!
    expect(record.anomalies).toEqual([
      `budget exceeded: tokens (observed 110 whole-session tokens over the limit 100; post-hoc check at terminal time, session-scoped cumulative — the run was not stopped in flight) — ${escalationHint(
        'the run already spent more tokens than its budget allows',
        'the run finished before the breach was observable',
        'raise the budget, split the task, or accept the overspend',
      )}`,
    ])
  })
})

describe('TaskRuntime criterion verifierRef (KISS §4.1, VRTC plan 1.4)', () => {
  test('an unknown verifierRef rejects the whole batch at admission, listing the registered ids, and persists nothing', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(
      decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
        reason: 'split the work',
        children: [
          childSpec('pinned child', {
            acceptanceCriteria: [{ description: 'judged by a pinned verifier', command: 'true', verifierRef: 'ghost' }],
          }),
        ],
      }),
    ).rejects.toThrow(
      /admission rejected decomposition of "[^"]+": child 0 criterion "ac1-1" references unknown verifier "ghost"; registered verifiers: command, composite, review/,
    )

    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })

  test('a registered verifierRef is admitted, stored on the criterion, and the run verifies as usual', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('pinned child', {
          acceptanceCriteria: [{ description: 'judged by a pinned verifier', command: 'true', verifierRef: 'command' }],
        }),
      ],
    })

    expect(outcomes[0]!.status).toBe('verified')
    expect((await h.task.taskIn(STORE, outcomes[0]!.taskId)).acceptanceCriteria[0]!.verifierRef).toBe('command')
  })

  test('a declared verifierRef with no verifier service to validate against fails loudly before anything persists', async () => {
    const h = harness({ verifier: 'absent' })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    await expect(
      decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
        reason: 'split the work',
        children: [
          childSpec('pinned child', {
            acceptanceCriteria: [
              { description: 'judged by a pinned verifier', command: 'true', verifierRef: 'command' },
            ],
          }),
        ],
      }),
    ).rejects.toThrow(VerifierUnavailableError)

    expect((await h.task.snapshotIn(STORE)).tasks).toHaveLength(1)
    expect(h.spawned).toHaveLength(0)
  })

  test('an unknown verifierRef on a replay contract is rejected before anything persists', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('champion work')],
    })
    expect(outcomes[0]!.status).toBe('verified')

    await expect(
      h.runtime.replayTask(
        STORE,
        outcomes[0]!.taskId,
        {
          lineage: 'evolution-replay:p-ref',
          spawn: false,
          contract: {
            objective: 'candidate with a pinned judge',
            acceptanceCriteria: [
              {
                criterionId: 'cd-1',
                description: 'x',
                verificationMode: 'deterministic',
                requiredEvidence: [],
                mandatory: true,
                command: 'true',
                verifierRef: 'ghost',
              },
            ],
            requiredCapabilities: ['execute-task'],
          },
        },
        ROOT_SESSION,
      ),
    ).rejects.toThrow(
      /admission rejected replay of "[^"]+": child 0 criterion "cd-1" references unknown verifier "ghost"; registered verifiers: command, composite, review/,
    )
  })
})

describe('TaskRuntime unknown-kind feedback (KISS §4.3, VRTC plan 2.1)', () => {
  test('the failure reason tells an untested criterion (unknown: task) apart from a broken judge (unknown: verifier)', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const original = h.verifier.verifyRun.getMockImplementation()!
    h.verifier.verifyRun.mockImplementation(async (storeId: string, runId: string) => {
      if (runId === rootRunId) return original(storeId, runId)
      const run = await h.task.runIn(storeId, runId)
      const instance = await h.task.taskIn(storeId, run.taskId)
      const verifierBroken = instance.objective.includes('broken-judge')
      const verifierResults: VerificationResult[] = instance.acceptanceCriteria.map(criterion => ({
        criterionId: criterion.criterionId,
        status: 'inconclusive' as const,
        verifierId: 'fake-verifier',
        details: verifierBroken ? 'verifier exploded' : 'timeout after 600000ms',
        unknownKind: (verifierBroken ? 'verifier' : 'task') as 'task' | 'verifier',
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
          verifierId: 'fake-verifier',
          artifactRefs: [],
          unknownKind: result.unknownKind,
        })),
        generatedAt: new Date().toISOString(),
      }
      await h.task.recordEvidenceIn(storeId, bundle, 'fake-verifier')
      return bundle
    })

    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('untested child'), childSpec('broken-judge child')],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'failed'])
    const reasonOf = (runId: string) =>
      taskEvents(h)
        .filter(item => item.kind === 'TaskFailed' && item.runId === runId)
        .map(item => (item.kind === 'TaskFailed' ? item.payload.reason : undefined))[0]
    expect(reasonOf(outcomes[0]!.runId!)).toBe(
      'mandatory criteria not satisfied: ac1-1 inconclusive [unknown: task — the criterion was never tested] (timeout after 600000ms)',
    )
    expect(reasonOf(outcomes[1]!.runId!)).toBe(
      `mandatory criteria not satisfied: ac2-1 inconclusive [unknown: verifier — the verifier could not judge] ${escalationHint(
        'the verifier "fake-verifier" could not judge criterion "ac2-1"',
        'the criterion was run and the judge itself failed',
        'fix or replace the verifier, then re-verify the criterion',
      )} (verifier exploded)`,
    )

    // The review record carries the kind too, so E3 can be read without the bundle.
    // It also carries the deciding judge since S1-V slice 2, copied off the
    // verifier result — the record names who decided, not only what was decided.
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.reviews.find(item => item.runId === outcomes[0]!.runId)!.criteria).toEqual([
      {
        criterionId: 'ac1-1',
        verdict: 'inconclusive',
        verifierId: 'fake-verifier',
        command: 'true',
        unknownKind: 'task',
      },
    ])
    expect(snapshot.reviews.find(item => item.runId === outcomes[1]!.runId)!.criteria).toEqual([
      {
        criterionId: 'ac2-1',
        verdict: 'inconclusive',
        verifierId: 'fake-verifier',
        command: 'true',
        unknownKind: 'verifier',
      },
    ])
  })
})
