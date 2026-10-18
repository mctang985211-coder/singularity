import { describe, expect, it } from 'vitest'
import { MemoryLog } from '../src/protocol/memory-log.ts'
import { foldSubjects } from '../src/protocol/fold.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../src/task/protocol.ts'
import { assertWorkflowBudget, workflowBudget, type WorkflowLimits } from '../src/task/budget.ts'
import { admitted, assigned, bubbleOpened, contract, failed, INTEGRATION_VERIFIER, judged, RUN_ID, started, SUBJECTS, TASK_ID, taskRegistry, UNIT_VERIFIER, verified } from './task-fixtures.ts'
import { AGENT, CHILD, commandsFor, createRevision, deployment, openAgent, PARENT, pin, planned } from './command-fixtures.ts'
import { asyncRefusalOf } from './fixtures.ts'

const limits: WorkflowLimits = { maxSteps: 1024, maxNodes: 5, maxPlans: 3, maxRuns: 6, maxNoProgress: 3 }
const child = (taskId: string) => ({ taskId, dependsOn: [], supports: ['correctness'], maxRuns: 5, requirement: 'required' as const })
const emit = (log: MemoryLog, kind: string, subject: string, payload: unknown) => log.emit({
  commandId: `${kind}:${subject}:${log.count}`, protocol: TASK_PROTOCOL, version: TASK_VERSION, kind, subject, payload,
})
const states = (log: MemoryLog) => foldSubjects<TaskState>(taskRegistry(), log.entries(), TASK_PROTOCOL, TASK_VERSION)

describe('frozen whole-workflow limits', () => {
  it('freezes once before the first Run and preserves command replay', () => {
    const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
    expect(() => emit(log, 'workflow/limits-frozen', TASK_ID, limits)).toThrow('freeze workflow limits once')
    log.emit(admitted()); log.emit(assigned())
    const command = { commandId: 'freeze-once', protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'workflow/limits-frozen', subject: TASK_ID, payload: limits }
    const fact = log.emit(command), count = log.count
    expect(log.emit(command)).toEqual(fact)
    expect(log.count).toBe(count)
    expect(() => log.emit({ ...command, commandId: 'raise-limits', payload: { ...limits, maxRuns: 99 } })).toThrow('freeze workflow limits once')
    log.emit(started())
    expect(states(log).get(TASK_ID)!.workflowLimits).toEqual(limits)
    const late = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
    late.emit(admitted()); late.emit(assigned()); late.emit(started())
    expect(() => emit(late, 'workflow/limits-frozen', TASK_ID, limits)).toThrow('before the first Run')
  })

  it.each(['maxNodes', 'maxPlans', 'maxRuns', 'maxNoProgress'] as const)('rejects invalid %s without appending', key => {
    const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
    log.emit(admitted())
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2']) {
      const count = log.count
      expect(() => emit(log, 'workflow/limits-frozen', TASK_ID, { ...limits, [key]: value })).toThrow('positive')
      expect(log.count).toBe(count)
    }
  })

  it('counts descendants, planned IDs, attempts and no-progress across a cold fold', () => {
    const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
    log.emit(admitted()); log.emit(assigned()); emit(log, 'workflow/limits-frozen', TASK_ID, limits); log.emit(started())
    emit(log, 'task/decomposed', TASK_ID, { children: [child('child-a')] })
    log.emit({ ...admitted(), subject: 'child-a' }); log.emit({ ...assigned(), subject: 'child-a' })
    log.emit({ ...started('child-run-1'), subject: 'child-a' })
    log.emit({ ...failed('no result', 'child-run-1'), subject: 'child-a' })
    log.emit({ ...started('child-run-2'), subject: 'child-a' })
    emit(log, 'task/decomposed', 'child-a', { children: [child('grandchild-new-id')] })
    const expected = { rootId: TASK_ID, limits, nodes: 3, plans: 2, runs: 3, noProgress: 3 }
    for (const taskId of [TASK_ID, 'child-a', 'grandchild-new-id']) expect(workflowBudget(states(log), log.entries(), taskId)).toEqual(expected)
    const restored = MemoryLog.adopt(JSON.parse(JSON.stringify(log.entries())), taskRegistry(), { subjects: SUBJECTS })
    expect(workflowBudget(states(restored), restored.entries(), 'child-a')).toEqual(expected)
    expect(() => assertWorkflowBudget(states(restored), restored.entries(), 'grandchild-new-id', { runs: 1 })).toThrow('no progress 3/3')
    expect(() => assertWorkflowBudget(states(restored), restored.entries(), 'child-a', { nodes: 3 })).toThrow('nodes 3/5')
    expect(() => assertWorkflowBudget(states(restored), restored.entries(), TASK_ID, { plans: 2 })).toThrow('plans 2/3')
  })

  it('resets only the no-progress counter on verified progress within the same root', () => {
    const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
    log.emit(admitted()); log.emit(assigned()); emit(log, 'workflow/limits-frozen', TASK_ID, limits); log.emit(started())
    log.emit(bubbleOpened()); log.emit(judged('correctness', UNIT_VERIFIER)); log.emit(judged('limits', INTEGRATION_VERIFIER)); log.emit(verified())
    expect(workflowBudget(states(log), log.entries(), TASK_ID)).toMatchObject({ runs: 1, noProgress: 0 })
    emit(log, 'task/decomposed', TASK_ID, { children: [child('future-child')] })
    log.emit({ ...admitted(), subject: 'future-child' }); log.emit({ ...assigned(), subject: 'future-child' }); log.emit({ ...started(), subject: 'future-child' })
    for (const input of [admitted(), assigned(), started(), bubbleOpened(), judged('correctness', UNIT_VERIFIER), judged('limits', INTEGRATION_VERIFIER), verified()])
      log.emit({ ...input, subject: 'unrelated-root' })
    expect(workflowBudget(states(log), log.entries(), 'future-child')).toMatchObject({ rootId: TASK_ID, nodes: 2, runs: 2, noProgress: 1 })
  })

  it.each(['maxNodes', 'maxPlans', 'maxRuns', 'maxNoProgress'] as const)('enforces %s at the real serial command boundary', async key => {
    const live = await deployment()
    try {
      await openAgent(live); await createRevision(live)
      const commands = await planned(live, 5)
      await live.store.emit({ commandId: 'freeze-root-limits', protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'workflow/limits-frozen', subject: PARENT,
        payload: { maxSteps: 1024, maxNodes: 8, maxPlans: 8, maxRuns: 8, maxNoProgress: 8, [key]: key === 'maxNodes' ? 2 : 1 } })
      const newId = 'new-sibling-id'
      await commands.admit({ commandId: 'admit-new-id', taskId: newId, contract: { ...contract(), goal: 'A separate supported obligation' } })
      await commands.assign({ commandId: 'assign-new-id', taskId: newId, agentId: AGENT })
      const plan = () => commands.decompose({ commandId: 'append-new-id', parentTaskId: PARENT, children: [child(newId)] })
      if (key === 'maxNodes' || key === 'maxPlans') {
        const count = live.store.load().entries().length
        expect(await asyncRefusalOf(plan)).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining(`workflow budget exhausted at ${PARENT}`) })
        expect(live.store.load().entries()).toHaveLength(count)
      } else {
        await plan()
        await commands.startRun({ purpose: 'solve', commandId: 'start-first', taskId: CHILD, runId: RUN_ID, revision: pin(live) })
        const count = live.store.load().entries().length
        expect(await asyncRefusalOf(() => commandsFor(live).startRun({ purpose: 'solve', commandId: 'start-new-id', taskId: newId, runId: 'fresh-run-id', revision: pin(live) })))
          .toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining(`workflow budget exhausted at ${PARENT}`) })
        expect(live.store.load().entries()).toHaveLength(count)
      }
    } finally { await live.store.close() }
  })
})
