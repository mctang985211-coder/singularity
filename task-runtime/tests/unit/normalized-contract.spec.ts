import { describe, expect, test } from 'vitest'
import type { DecomposeSpec } from '../../src/index.ts'
import { normalizeDecomposition } from '../../src/index.ts'
import { DEFAULT_BUDGET, DEFAULT_MAX_CHILDREN, DEFAULT_MAX_DEPTH } from '../../src/index.ts'
import {
  harness,
  createRoot,
  childSpec,
  decomposeAndSettle,
  STORE,
  ROOT_SESSION,
  taskEvents,
  createAcceptanceParent,
} from './orchestrate.fixture.ts'

describe('TaskRuntime normalized contract (T1, construction guide §4)', () => {
  test('a batch admitted with contracts persists them, with the batch identity and limits on the parent event', async () => {
    const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const spec: DecomposeSpec = {
      reason: 'split the work',
      children: [
        childSpec('child a', {
          assumptions: ['a cycle-accurate reference model exists'],
          constraints: ['no network access'],
          requiredCapabilities: ['research'],
        }),
      ],
    }
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, spec)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    const child = await h.task.taskIn(STORE, outcomes[0]!.taskId)
    expect(child.contract).toEqual({
      contractVersion: 1,
      templateScope: [],
      objective: 'child a',
      acceptanceCriteria: [
        {
          criterionId: 'ac1-1',
          description: 'child a works',
          verificationMode: 'deterministic',
          requiredEvidence: [],
          mandatory: true,
          command: 'true',
        },
      ],
      assumptions: ['a cycle-accurate reference model exists'],
      constraints: ['no network access'],
      requiredCapabilities: ['research'],
    })
    // The stored projections are the contract, not a second source that happens
    // to agree with it: the reducer checks exactly this on write.
    expect(child.objective).toBe(child.contract!.objective)
    expect(child.acceptanceCriteria).toEqual(child.contract!.acceptanceCriteria)
    expect(child.requestedCapabilities).toEqual(child.contract!.requiredCapabilities)

    const decomposed = taskEvents(h).find(item => item.kind === 'TaskDecomposed' && item.taskId === rootTaskId)
    const admission = decomposed?.kind === 'TaskDecomposed' ? decomposed.payload.admission : undefined
    expect(admission?.proposalDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(admission?.context).toStrictEqual({
      maxDepth: DEFAULT_MAX_DEPTH,
      maxChildren: DEFAULT_MAX_CHILDREN,
      auditOnly: { maxToolCalls: DEFAULT_BUDGET.maxToolCalls, attempts: 1 },
    })
    // The runtime writes the same batch identity the pure normalization entry
    // computes for the same proposal and parent — the ids it minted per child
    // are not part of it.
    const expected = normalizeDecomposition({ ...spec, children: spec.children!.map(child => ({ ...child, templateScope: [] })) }, {
      storeId: STORE,
      parentTaskId: rootTaskId,
      parentRunId: rootRunId,
      callerSessionId: ROOT_SESSION,
      admissionContext: { maxDepth: DEFAULT_MAX_DEPTH, maxChildren: DEFAULT_MAX_CHILDREN, auditOnly: {} },
    })
    if (!expected.ok) throw new Error(expected.reasons.join('\n'))
    expect(admission?.proposalDigest).toBe(expected.batch.admission.proposalDigest)
  })

  test('the contract survives a store reopen: it is read back from the events, not from memory', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child a', { assumptions: ['a reference model exists'], constraints: ['no network'] })],
    })
    const stored = (await h.task.taskIn(STORE, outcomes[0]!.taskId)).contract
    await Promise.all(h.disposers.map(dispose => dispose()))

    // A fresh service over the same session log: the contract has to come back
    // from the persisted TaskCreated event, not from the object still in memory.
    const h2 = harness()
    h2.sessions.clear()
    for (const [id, session] of h.sessions) h2.sessions.set(id, session)
    await h2.task.openStore(STORE)
    const reopened = await h2.task.taskIn(STORE, outcomes[0]!.taskId)
    expect(reopened.contract).toStrictEqual(stored)
    expect(reopened.contract!.constraints).toEqual(['no network'])
    expect(reopened.contract!.assumptions).toEqual(['a reference model exists'])
  })

  test('the admission context records the limits in force, including every configured audit-only value', async () => {
    const h = harness({ config: { maxDepth: 2, maxChildren: 3, budget: { tokens: 999 } } })
    const { taskId, runId } = await createRoot(h)
    await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec('child a')],
    })

    const decomposed = taskEvents(h).find(item => item.kind === 'TaskDecomposed')
    expect(decomposed?.kind === 'TaskDecomposed' ? decomposed.payload.admission?.context : undefined).toStrictEqual({
      maxDepth: 2,
      maxChildren: 3,
      auditOnly: { maxToolCalls: DEFAULT_BUDGET.maxToolCalls, tokens: 999, attempts: 1 },
    })
  })

  test('a batch the contract rejects persists nothing and spawns nothing', async () => {
    const children = (child: Record<string, unknown>) => [child] as unknown as DecomposeSpec['children']
    const cases: Array<[string, DecomposeSpec, RegExp]> = [
      [
        'an unknown child field',
        {
          reason: 'split the work',
          children: children({
            objective: 'child a', requiredCapabilities: ['execute-task'],
            acceptanceCriteria: [{ description: 'child a works', command: 'true' }],
            skills: ['ball-align'],
          }),
        },
        /contract rejected decomposition of "[^"]+":\n- child 0 declares unknown field "skills"/,
      ],
      [
        'a duplicate explicit criterion id',
        {
          reason: 'split the work',
          children: children({
            objective: 'child a', requiredCapabilities: ['execute-task'],
            acceptanceCriteria: [
              { description: 'first', criterionId: 'dup', command: 'true' },
              { description: 'second', criterionId: 'dup', command: 'true' },
            ],
          }),
        },
        /contract rejected decomposition of "[^"]+":\n- child 0 declares criterion id "dup" more than once/,
      ],
      [
        'an unknown contract version',
        {
          reason: 'split the work',
          contractVersion: 2,
          children: [childSpec('child a')],
        },
        /contract rejected decomposition of "[^"]+":\n- unknown contract version 2: this runtime writes version 1/,
      ],
      [
        'an all-optional criterion list',
        {
          reason: 'split the work',
          children: children({
            objective: 'child a', requiredCapabilities: ['execute-task'],
            acceptanceCriteria: [{ description: 'nothing is required', command: 'true', mandatory: false }],
          }),
        },
        /admission rejected decomposition of "[^"]+":\n- child 0 requires at least one mandatory acceptance criterion/,
      ],
      [
        'a null mode',
        {
          reason: 'split the work',
          children: children({
            objective: 'child a', requiredCapabilities: ['execute-task'],
            acceptanceCriteria: [{ description: 'child a works', command: 'true', mode: null }],
          }),
        },
        /admission rejected decomposition of "[^"]+":\n- child 0 criterion "ac1-1" verificationMode "null" is not one of deterministic, simulation, formal, measurement, review, composite/,
      ],
      [
        'a numeric mode',
        {
          reason: 'split the work',
          children: children({
            objective: 'child a', requiredCapabilities: ['execute-task'],
            acceptanceCriteria: [{ description: 'child a works', command: 'true', mode: 0 }],
          }),
        },
        /admission rejected decomposition of "[^"]+":\n- child 0 criterion "ac1-1" verificationMode "0" is not one of deterministic, simulation, formal, measurement, review, composite/,
      ],
    ]

    for (const [label, spec, expected] of cases) {
      const h = harness()
      const { taskId, runId } = await createRoot(h)
      const before = await h.task.snapshotIn(STORE)
      await expect(decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, spec), label).rejects.toThrow(expected)
      expect(h.spawned, label).toHaveLength(0)
      expect(await h.task.snapshotIn(STORE), label).toEqual(before)
      // No child task id reached the store: the parent is still alone.
      expect(
        taskEvents(h).some(item => item.kind === 'TaskCreated' && item.taskId !== taskId),
        label,
      ).toBe(false)
      expect(
        taskEvents(h).some(item => item.kind === 'TaskDecomposed'),
        label,
      ).toBe(false)
    }
  })

  test('the handoff carries the contract constraints beside the declared assumptions, dependency evidence last', async () => {
    const h = harness()
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [
        childSpec('reference producer'),
        childSpec('downstream', {
          dependsOn: [0],
          assumptions: ['a cycle-accurate reference model exists'],
          constraints: ['no network access', 'finish inside ten minutes'],
        }),
      ],
    })

    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified'])
    const snapshot = await h.task.snapshotIn(STORE)
    const downstream = snapshot.handoffs.find(item => item.childTaskId === outcomes[1]!.taskId)!
    expect(downstream.constraints).toEqual(['no network access', 'finish inside ten minutes'])
    expect(downstream.assumptions).toEqual([
      'a cycle-accurate reference model exists',
      `dependency evidence "${outcomes[0]!.evidenceId!}" is verified and available as a reference`,
    ])
    // Both declarations reach the worker through its assembled contract — the
    // projection's handoff block, read from this record — and the spawn request
    // carries no rendering of its own (A2).
    expect(h.spawned[1]!.taskWorker).toBe(true)
    expect(h.spawned[1]!.prompt).toBeUndefined()
    // The stored child contract keeps the same declarations the handoff rendered.
    const child = await h.task.taskIn(STORE, outcomes[1]!.taskId)
    expect(child.contract!.constraints).toEqual(['no network access', 'finish inside ten minutes'])
    expect(child.contract!.assumptions).toEqual(['a cycle-accurate reference model exists'])
  })

  test('the same proposal submitted twice keeps one digest; a changed criterion, constraint or assumption moves it', async () => {
    /** One submission of `children` from a parent whose ids are fixed, so two runs differ only in the child ids they mint. */
    const submitted = async (children: DecomposeSpec['children']) => {
      const h = harness()
      const { taskId, runId } = await createAcceptanceParent(h, [
        {
          criterionId: 'root-combination',
          description: 'the children together prove the root goal',
          verificationMode: 'composite',
          requiredEvidence: [],
          mandatory: true,
        },
      ])
      await decomposeAndSettle(h, STORE, taskId, runId, ROOT_SESSION, { reason: 'split the work', children })
      const decomposed = taskEvents(h).find(item => item.kind === 'TaskDecomposed')
      if (decomposed?.kind !== 'TaskDecomposed' || decomposed.payload.admission === undefined) {
        throw new Error('the batch was not admitted')
      }
      const childIds = (await h.task.snapshotIn(STORE)).tasks
        .filter(task => task.parentTaskId === 't-parent')
        .map(task => task.taskId)
        .sort()
      return { digest: decomposed.payload.admission.proposalDigest, childIds }
    }

    const withDeclarations = () =>
      childSpec('child a', { constraints: ['no network'], assumptions: ['a reference exists'] })
    const first = await submitted([withDeclarations(), childSpec('child b', { dependsOn: [0] })])
    const second = await submitted([withDeclarations(), childSpec('child b', { dependsOn: [0] })])

    expect(first.digest).toBe(second.digest)
    // ...although the two submissions were admitted with different minted ids.
    expect(first.childIds).not.toEqual(second.childIds)
    expect(first.childIds).toHaveLength(2)

    const variants: Array<[string, DecomposeSpec['children']]> = [
      [
        'a criterion changed',
        [
          childSpec('child a', {
            constraints: ['no network'],
            assumptions: ['a reference exists'],
            acceptanceCriteria: [{ description: 'child a passes', command: 'true' }],
          }),
          childSpec('child b', { dependsOn: [0] }),
        ],
      ],
      [
        'a constraint changed',
        [
          childSpec('child a', { constraints: ['offline'], assumptions: ['a reference exists'] }),
          childSpec('child b', { dependsOn: [0] }),
        ],
      ],
      [
        'an assumption changed',
        [
          childSpec('child a', { constraints: ['no network'], assumptions: ['a faster host exists'] }),
          childSpec('child b', { dependsOn: [0] }),
        ],
      ],
    ]
    for (const [label, children] of variants) {
      expect((await submitted(children)).digest, label).not.toBe(first.digest)
    }
  })
})
