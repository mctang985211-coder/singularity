/**
 * The command boundary: cross-entity preconditions checked inside the serial region.
 *
 * The property this spec exists for is atomicity. A precondition read outside the queue, or against
 * a cut taken earlier, is a check against a state that may already be gone — so the last case here
 * fires two commands at once against a budget of one and requires exactly one to succeed. A
 * boundary that checked first and queued afterwards would let both through.
 *
 * The rest is the set of conditions a per-subject reducer cannot decide: whether the revision a run
 * pins exists, whether the agent exists and has been opened, whether a plan allows the sub-task to
 * start, and whether the deployment holds the implementation that produced a verdict.
 */

import { describe, expect, it } from 'vitest'

import {
  createTaskCommands,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_VERSION,
  type RefusalCode,
  refuse,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  type TaskState,
} from '../src/index.ts'
import { asyncRefusalOf, refusalOf } from './fixtures.ts'
import {
  AGENT,
  CHILD,
  commandsFor,
  createRevision,
  deployment,
  ENVIRONMENT,
  openAgent,
  PARENT,
  pin,
  planned,
  registry,
  REVISION,
  RUN,
} from './command-fixtures.ts'
import { BUBBLE_INPUTS, contract as parentContract, SCHEDULER, UNIT_IMPLEMENTATION, UNIT_VERIFIER } from './task-fixtures.ts'

describe('a run starts only when every cross-entity condition holds', () => {
  it('refuses a run pinned to a revision this log never recorded, or to the wrong content', async () => {
    const live = await deployment()
    await openAgent(live)
    const commands = await planned(live)

    // Nothing is created yet, so both an environment nobody recorded and a revision nobody created
    // are refused the same way: neither can be resolved to content.
    const placeholder = 'a'.repeat(64)
    const absent = await asyncRefusalOf(() =>
      commands.startRun({ commandId: 'r-absent', taskId: PARENT, runId: RUN, revision: { environmentId: ENVIRONMENT, revisionId: 'r-nope', digest: placeholder } }),
    )
    expect(absent.code).toBe<RefusalCode>('unknown-revision')

    const unrecordedEnvironment = await asyncRefusalOf(() =>
      commands.startRun({ commandId: 'r-env', taskId: PARENT, runId: RUN, revision: { environmentId: 'library-nope', revisionId: REVISION, digest: placeholder } }),
    )
    expect(unrecordedEnvironment.code).toBe<RefusalCode>('unknown-revision')

    await createRevision(live)
    const wrongContent = await asyncRefusalOf(() =>
      commands.startRun({ commandId: 'r-digest', taskId: PARENT, runId: RUN, revision: pin(live, { digest: 'a'.repeat(64) }) }),
    )
    expect(wrongContent.code).toBe<RefusalCode>('unknown-revision')

    // The pin the log can honour is accepted.
    const started = await commands.startRun({ commandId: 'r-ok', taskId: PARENT, runId: RUN, revision: pin(live) })
    expect(started.kind).toBe(TASK_KINDS.runStarted)
  })

  it('refuses a run nobody is answerable for, an agent the deployment does not hold, and an agent with no node', async () => {
    const live = await deployment()
    await createRevision(live)
    await openAgent(live)
    const commands = commandsFor(live)
    await commands.admit({ commandId: 'admit-parent', taskId: PARENT, contract: parentContract() })

    const unassigned = await asyncRefusalOf(() => commands.startRun({ commandId: 's-none', taskId: PARENT, runId: RUN, revision: pin(live) }))
    expect(unassigned.code).toBe<RefusalCode>('not-responsible')

    // Held by the deployment but never opened: no session backs it, so it cannot be worked by.
    const notOpened = await asyncRefusalOf(() =>
      createTaskCommands({
        store: live.store,
        registry: live.registry,
        agents: new Map([['agent-ghost', { identity: SCHEDULER }]]),
        implementations: [],
      }).assign({ commandId: 'a-ghost', taskId: PARENT, agentId: 'agent-ghost' }),
    )
    expect(notOpened.code).toBe<RefusalCode>('unknown-emitter-role')
    expect(notOpened.detail).toContain('no opened node')

    const notHeld = await asyncRefusalOf(() => commands.assign({ commandId: 'a-unknown', taskId: PARENT, agentId: 'agent-nobody-holds' }))
    expect(notHeld.code).toBe<RefusalCode>('unknown-emitter-role')
    expect(notHeld.detail).toContain('not one this deployment holds')
  })

  it('fills the responsible identity from the deployment, not from the caller', async () => {
    const live = await deployment()
    await openAgent(live)
    const commands = commandsFor(live)
    await commands.admit({ commandId: 'admit-parent', taskId: PARENT, contract: parentContract() })
    await commands.assign({ commandId: 'assign', taskId: PARENT, agentId: AGENT })

    const state = live.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, PARENT)
    expect(state?.responsibility?.agentId).toBe(AGENT)
    expect(state?.responsibility?.agentIdentity).toBe(SCHEDULER)
  })

  it('refuses a sub-task the plan does not call ready, quoting the plan', async () => {
    const live = await deployment()
    await createRevision(live)
    await openAgent(live)
    const commands = commandsFor(live)
    await commands.admit({ commandId: 'admit-parent', taskId: PARENT, contract: parentContract() })
    await commands.admit({
      commandId: 'admit-blocked',
      taskId: CHILD,
      contract: { goal: 'g', inputs: [], criteria: [{ criterionId: 'p', statement: 's', verifierRef: UNIT_VERIFIER, verifierVersion: '1', implementationDigest: UNIT_IMPLEMENTATION }] },
    })
    // The child waits on a sibling the plan declares but nobody admitted.
    await commands.decompose({
      commandId: 'plan',
      parentTaskId: PARENT,
      children: [{ taskId: CHILD, dependsOn: ['task-sibling'], supports: ['correctness'], maxRuns: 1 }, { taskId: 'task-sibling', dependsOn: [], supports: ['limits'], maxRuns: 1 }],
    })
    await commands.assign({ commandId: 'assign-child', taskId: CHILD, agentId: AGENT })

    const blocked = await asyncRefusalOf(() => commands.startRun({ commandId: 'r-blocked', taskId: CHILD, runId: RUN, revision: pin(live) }))
    expect(blocked.code).toBe<RefusalCode>('illegal-transition')
    expect(blocked.detail).toContain('task-sibling')
    expect(blocked.detail).toContain('only a verified dependency')
  })

  it('refuses work once the plan budget is spent, and admits exactly one of two concurrent starts', async () => {
    const live = await deployment()
    await createRevision(live)
    await openAgent(live)
    const commands = await planned(live, 1)

    // Two commands in flight at once against a budget of one. The cut is taken inside the queued
    // step, so the second sees the first's committed run and is refused. Checking before queueing
    // would let both through and start two runs nobody budgeted for.
    const outcomes = await Promise.allSettled([
      commands.startRun({ commandId: 'r-first', taskId: CHILD, runId: 'run-a', revision: pin(live) }),
      commands.startRun({ commandId: 'r-second', taskId: CHILD, runId: 'run-b', revision: pin(live) }),
    ])
    const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled')
    const rejected = outcomes.filter(outcome => outcome.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    const state = live.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, CHILD)
    expect(Object.keys(state?.runs ?? {})).toHaveLength(1)

    // While that run is unsettled the sub-task is `running`, and a second start is refused for that
    // reason. Settling it as failed is what turns the same sub-task into `stopped`: the budget is
    // spent and no run verified, so the plan says so in its own words.
    const settled = fulfilled[0] as PromiseFulfilledResult<{ payload: { runId: string } }>
    await commands.failRun({ commandId: 'f1', taskId: CHILD, runId: settled.value.payload.runId, reason: 'the counting attempt failed' })

    const spent = await asyncRefusalOf(() => commands.startRun({ commandId: 'r-third', taskId: CHILD, runId: 'run-c', revision: pin(live) }))
    expect(spent.code).toBe<RefusalCode>('illegal-transition')
    expect(spent.detail).toContain('budget exhausted')
    expect(spent.detail).toContain('1 of 1')
  })
})

describe('a verdict is produced by a verifier, not by an agent', () => {
  it('offers an agent no way to produce one', async () => {
    const live = await deployment()
    await openAgent(live)
    const commands = commandsFor(live)
    const asAgent = commands.forAgent(AGENT)

    expect(Object.keys(asAgent).sort()).toEqual(['admit', 'assign', 'decompose', 'failRun', 'openBubble', 'reassign', 'startRun'])
    expect('recordVerdict' in asAgent).toBe(false)
    expect(() => commands.forAgent('agent-nobody-holds')).toThrowError(/not one this deployment holds/)
  })

  it('takes the verifier identity from the frozen criterion and refuses an unheld implementation', async () => {
    const live = await deployment()
    await openAgent(live)
    await createRevision(live)
    const commands = await planned(live)
    await commands.startRun({ commandId: 'r1', taskId: CHILD, runId: RUN, revision: pin(live) })
    await commands.openBubble({ commandId: 'b1', taskId: CHILD, runId: RUN, inputs: BUBBLE_INPUTS, workspace: { kind: 'git', ref: 'refs/heads/main' } })

    const fromElsewhere = await asyncRefusalOf(() =>
      commands.recordVerdict({
        commandId: 'v-wrong',
        taskId: CHILD,
        verdict: { runId: RUN, criterionId: 'part', verdict: 'pass', implementationDigest: 'e'.repeat(64), artifactDigest: 'b'.repeat(64), inputDigests: BUBBLE_INPUTS },
      }),
    )
    expect(fromElsewhere.code).toBe<RefusalCode>('wrong-verifier')

    const recorded = await commands.recordVerdict({
      commandId: 'v-ok',
      taskId: CHILD,
      verdict: { runId: RUN, criterionId: 'part', verdict: 'pass', implementationDigest: UNIT_IMPLEMENTATION, artifactDigest: 'b'.repeat(64), inputDigests: BUBBLE_INPUTS },
    })
    const evidence = recorded.payload as { verifierRef: string; verifierVersion: string; inputDigests: unknown }
    expect(evidence.verifierRef).toBe(UNIT_VERIFIER)
    expect(evidence.verifierVersion).toBe('1')
    expect(evidence.inputDigests).toEqual(BUBBLE_INPUTS)
  })
})

describe('the command boundary against a store that refuses', () => {
  it('refuses a command for a task that was never admitted', async () => {
    const live = await deployment()
    await createRevision(live)
    const commands = commandsFor(live)
    const refusal = await asyncRefusalOf(() => commands.startRun({ commandId: 'r', taskId: 'task-ghost', runId: RUN, revision: pin(live) }))
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
    expect(refusal.detail).toContain('no admitted contract')
  })

  it('reports a malformed command as a refusal rather than throwing a bare error', () => {
    // The environment role must exist, or the command boundary's own facts cannot be produced.
    expect(refusalOf(() => registry().ruleFor(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, 'revision/nope')).code).toBe<RefusalCode>('unknown-kind')
    expect(() => refuse('malformed-payload', 'checked')).toThrowError(/malformed-payload/)
  })
})
