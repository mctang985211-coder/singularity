/**
 * E2 (`docs/tdd-seams.md` §4): what a run actually consumed, and which declared methods nothing did.
 *
 * R08: pinning a revision proves nothing about which of its methods were used. So the apparatus
 * records one fact per use — which run, at which revision, which method, and where the claim comes
 * from — and `unconsumedMethods` compares a revision's declared names against the facts below a
 * cutoff. `declared` is read by the deployment from its own manifest format: this protocol does not
 * define somebody else's manifest.
 *
 * Every expected value is a hand-written literal; none is computed by the code under test.
 */

import { describe, expect, it } from 'vitest'

import {
  AGENT_ROLE,
  MemoryLog,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  type EmitInput,
  type RefusalCode,
  type RevisionRef,
} from '../src/index.ts'
import { unconsumedMethods } from '../src/task/consumption.ts'
import { CHILD, createRevision, deployment, ENVIRONMENT, openAgent, pin, planned, REVISION, RUN,
} from './command-fixtures.ts'
import { refusalOf } from './fixtures.ts'
import { admitted, assigned, failed, REVISION as PIN, RUN_ID, SCHEDULER, started, TASK_ID, taskRegistry,
} from './task-fixtures.ts'

/** The method names this revision declares, as a deployment read them out of its own manifest. */
const DECLARED = ['word-count', 'limit-check', 'normalize']
const SOURCE = 'apparatus: tool-call log of run 1'
/** The identity this deployment holds for the runtime role — the apparatus, never the agent. */
const SUBJECTS: Readonly<Record<string, string>> = { scheduler: SCHEDULER, [AGENT_ROLE]: 'apparatus-1' }

let commands = 0

/** One consumption fact, as the apparatus would emit it. */
const consumed = (options: {
  readonly method: string
  readonly source?: string
  readonly revision?: RevisionRef
  readonly runId?: string
}): EmitInput => ({
  commandId: `consume-${(commands += 1)}`,
  protocol: TASK_PROTOCOL,
  version: TASK_VERSION,
  kind: TASK_KINDS.methodConsumed,
  subject: TASK_ID,
  payload: {
    runId: options.runId ?? RUN_ID,
    revision: options.revision ?? PIN,
    method: options.method,
    source: options.source ?? SOURCE,
  },
})

/** A log with an admitted, assigned task and one running run pinned to `PIN`. */
async function running(): Promise<MemoryLog> {
  const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS, now: () => '2026-10-10T00:00:00.000Z' })
  await log.emit(admitted())
  await log.emit(assigned())
  await log.emit(started())
  return log
}

describe('a consumption fact is bound to the run it names', () => {
  it('refuses a revision other than the one the run pinned', async () => {
    const log = await running()
    const elsewhere = consumed({ method: 'word-count', revision: { ...PIN, revisionId: 'r0002' } })
    expect(refusalOf(() => log.emit(elsewhere)).code).toBe<RefusalCode>('evidence-input-mismatch')
  })

  it('refuses a second fact for the same run and method', async () => {
    const log = await running()
    await log.emit(consumed({ method: 'word-count' }))
    expect(refusalOf(() => log.emit(consumed({ method: 'word-count' }))).code).toBe<RefusalCode>('evidence-conflict')
  })

  it('refuses a fact whose source is empty', async () => {
    const log = await running()
    expect(refusalOf(() => log.emit(consumed({ method: 'word-count', source: '' }))).code).toBe<RefusalCode>('malformed-payload',
    )
  })

  it('refuses a run this task never started', async () => {
    const log = await running()
    expect(refusalOf(() => log.emit(consumed({ method: 'word-count', runId: 'run-nope' }))).code).toBe<RefusalCode>('unknown-run',
    )
  })
})

describe('the declared methods nothing consumed, below a cutoff', () => {
  it('names the declared methods with no consumption fact', async () => {
    const log = await running()
    await log.emit(consumed({ method: 'limit-check' }))
    expect(unconsumedMethods(log.entries(), PIN.environmentId, PIN.revisionId, DECLARED, log.count)).toEqual(['word-count', 'normalize',
    ])
  })

  it('does not count a consumption fact above the cutoff', async () => {
    const log = await running()
    await log.emit(consumed({ method: 'limit-check' }))
    expect(unconsumedMethods(log.entries(), PIN.environmentId, PIN.revisionId, DECLARED, log.count - 1)).toEqual([
      'word-count',
      'limit-check',
      'normalize',
    ])
  })

  it('does not count a method consumed at another revision', async () => {
    const log = await running()
    const elsewhere = { environmentId: PIN.environmentId, revisionId: 'r0002', digest: 'c'.repeat(64) }
    await log.emit(failed('attempt complete'))
    await log.emit({
      commandId: 'start-run-2',
      protocol: TASK_PROTOCOL,
      version: TASK_VERSION,
      kind: TASK_KINDS.runStarted,
      subject: TASK_ID,
      payload: { purpose: 'solve', runId: 'run-2', revision: elsewhere },
    })
    await log.emit(consumed({ method: 'normalize', runId: 'run-2', revision: elsewhere }))
    expect(unconsumedMethods(log.entries(), PIN.environmentId, PIN.revisionId, DECLARED, log.count)).toEqual([
      'word-count',
      'limit-check',
      'normalize',
    ])
  })
})

describe('the trusted command surface', () => {
  it('records consumption through the apparatus role and nothing else', async () => {
    const live = await deployment()
    await openAgent(live)
    await createRevision(live)
    const commands = await planned(live)
    await commands.startRun({
      purpose: 'solve',
      commandId: 'start-child', taskId: CHILD, runId: RUN, revision: pin(live),
    })
    const recorded = await commands.recordConsumption({ commandId: 'consumed-1', taskId: CHILD, runId: RUN, revision: pin(live), method: 'word-count', source: SOURCE,
    })
    const entries = live.store.load().entries()
    // The log stamps the role, not the caller: the apparatus's own role, never the scheduler's.
    expect(recorded.emitter).toBe('runtime')
    expect(unconsumedMethods(entries, ENVIRONMENT, REVISION, ['word-count', 'limit-check'], entries.length)).toEqual(['limit-check',
    ])
  })
})
