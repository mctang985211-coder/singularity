import { reviewedVerdict } from './command-fixtures.ts'
/**
 * The command boundary: cross-entity preconditions checked inside the serial region.
 */

import { describe, expect, it } from 'vitest'

import {
  AGENT_KINDS,
  AGENT_PROTOCOL,
  AGENT_ROLE,
  AGENT_VERSION,
  createTaskCommands,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_VERSION,
  recordedVerdictDigest,
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
import {
  BUBBLE_CONDITIONS,
  BUBBLE_INPUTS,
  BUBBLE_MODEL,
  BUBBLE_TOOLS,
  contract as parentContract,
  SCHEDULER,
  UNIT_IMPLEMENTATION,
  UNIT_VERIFIER,
} from './task-fixtures.ts'

describe('a run starts only when every cross-entity condition holds', () => {
  it('refuses a run pinned to a revision this log never recorded, or to the wrong content', async () => {
    const live = await deployment()
    await openAgent(live)
    const commands = await planned(live)

    // Nothing is created yet, so both an environment nobody recorded and a revision nobody created
    // are refused the same way: neither can be resolved to content.
    const placeholder = 'a'.repeat(64)
    const absent = await asyncRefusalOf(() =>
      commands.startRun({
        purpose: 'solve',
        commandId: 'r-absent', taskId: PARENT, runId: RUN, revision: { environmentId: ENVIRONMENT, revisionId: 'r-nope', digest: placeholder },
      }),
    )
    expect(absent.code).toBe<RefusalCode>('unknown-revision')

    const unrecordedEnvironment = await asyncRefusalOf(() =>
      commands.startRun({
        purpose: 'solve',
        commandId: 'r-env', taskId: PARENT, runId: RUN, revision: { environmentId: 'library-nope', revisionId: REVISION, digest: placeholder },
      }),
    )
    expect(unrecordedEnvironment.code).toBe<RefusalCode>('unknown-revision')

    await createRevision(live)
    const wrongContent = await asyncRefusalOf(() =>
      commands.startRun({
        purpose: 'solve',
        commandId: 'r-digest', taskId: PARENT, runId: RUN, revision: pin(live, { digest: 'a'.repeat(64) }),
      }),
    )
    expect(wrongContent.code).toBe<RefusalCode>('unknown-revision')

    // The pin the log can honour is accepted.
    const started = await commands.startRun({
      purpose: 'solve',
      commandId: 'r-ok', taskId: PARENT, runId: RUN, revision: pin(live),
    })
    expect(started.kind).toBe(TASK_KINDS.runStarted)
  })

  it('refuses a run nobody is answerable for, an agent the deployment does not hold, and an agent with no node', async () => {
    const live = await deployment()
    await createRevision(live)
    await openAgent(live)
    const commands = commandsFor(live)
    await commands.admit({ commandId: 'admit-parent', taskId: PARENT, contract: parentContract() })

    const unassigned = await asyncRefusalOf(() => commands.startRun({ purpose: 'solve', commandId: 's-none', taskId: PARENT, runId: RUN, revision: pin(live) }),
    )
    expect(unassigned.code).toBe<RefusalCode>('not-responsible')

    // Held by the deployment but never opened: no session backs it, so it cannot be worked by.
    const notOpened = await asyncRefusalOf(() =>
      createTaskCommands({
        store: live.store,
        registry: live.registry,
        agents: new Map([['agent-ghost', { as: 'scheduler' }]]),
        implementations: [],
      }).assign({ commandId: 'a-ghost', taskId: PARENT, agentId: 'agent-ghost' }),
    )
    expect(notOpened).toMatchObject({ code: 'unknown-emitter-role', detail: expect.stringContaining('no opened node') })

    const notHeld = await asyncRefusalOf(() => commands.assign({ commandId: 'a-unknown', taskId: PARENT, agentId: 'agent-nobody-holds' }),
    )
    expect(notHeld).toMatchObject({ code: 'unknown-emitter-role', detail: expect.stringContaining('not one this deployment holds'),
    })
  })

  it('fills the responsible identity from the deployment, not from the caller', async () => {
    const live = await deployment()
    await openAgent(live)
    const commands = commandsFor(live)
    await commands.admit({ commandId: 'admit-parent', taskId: PARENT, contract: parentContract() })
    await commands.assign({ commandId: 'assign', taskId: PARENT, agentId: AGENT })

    const state = live.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, PARENT)
    expect([state?.responsibility?.agentId, state?.responsibility?.agentIdentity]).toEqual([AGENT, SCHEDULER])
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
      contract: {
        artifact: 'artifact.json',
        goal: 'g', template: { id: 'empty', digest: '1'.repeat(64) }, inputs: [], criteria: [{ criterionId: 'p', statement: 's' }],
      },
    })
    await commands.assign({ commandId: 'assign-parent', taskId: PARENT, agentId: AGENT })
    // The child waits on a sibling the plan declares but nobody admitted.
    await commands.decompose({
      commandId: 'plan',
      parentTaskId: PARENT,
      children: [{ taskId: CHILD, dependsOn: ['task-sibling'], supports: ['correctness'], maxRuns: 1 }, { taskId: 'task-sibling', dependsOn: [], supports: ['limits'], maxRuns: 1 },
      ],
    })
    await commands.assign({ commandId: 'assign-child', taskId: CHILD, agentId: AGENT })

    const blocked = await asyncRefusalOf(() => commands.startRun({ purpose: 'solve', commandId: 'r-blocked', taskId: CHILD, runId: RUN, revision: pin(live) }),
    )
    expect(blocked).toMatchObject({ code: 'illegal-transition', detail: expect.stringMatching(/task-sibling.*only a verified dependency/),
    })
  })

  it('refuses the parent while a sub-task of its own plan is running', async () => {
    const live = await deployment()
    await createRevision(live)
    await openAgent(live)
    const commands = await planned(live)
    await commands.startRun({
      purpose: 'solve',
      commandId: 'r-child', taskId: CHILD, runId: 'run-child', revision: pin(live),
    })

    // The child holds the acceptance its plan delegated to it, so the parent may not work on the same
    // acceptance at the same time. The refusal names the sub-task, so an operator knows what to wait for.
    const waiting = await asyncRefusalOf(() => commands.startRun({ purpose: 'solve', commandId: 'r-parent', taskId: PARENT, runId: RUN, revision: pin(live) }),
    )
    expect(waiting).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('delegated responsibilities are pending'),
    })
  })

  it('lets the parent run once its sub-task has settled', async () => {
    const live = await deployment()
    await createRevision(live)
    await openAgent(live)
    const commands = await planned(live)
    await commands.startRun({
      purpose: 'solve',
      commandId: 'r-child', taskId: CHILD, runId: 'run-child', revision: pin(live),
    })
    await commands.failRun({ commandId: 'f-child', taskId: CHILD, runId: 'run-child', reason: 'the attempt failed' })

    // The gate is "a sub-task is running", not "the plan is unfinished": a parent running its own
    // baseline before its children start, and again once they settle, is the ordinary shape of a campaign.
    const reached = await commands.startRun({
      purpose: 'solve',
      commandId: 'r-parent', taskId: PARENT, runId: RUN, revision: pin(live),
    })
    expect(reached.kind).toBe(TASK_KINDS.runStarted)
  })

  it("binds each agent surface to its own identity, so one agent cannot work another's task", async () => {
    const live = await deployment()
    await createRevision(live)
    await openAgent(live)
    const other = 'agent-2'
    await live.store.emit({ commandId: 'open-other', protocol: AGENT_PROTOCOL, version: AGENT_VERSION, kind: AGENT_KINDS.opened, subject: other, payload: { agentId: other, role: 'worker', sessionId: `singularity:agent:${other}` },
    })
    // Two executors, two bindings: the log tells them apart by what their acts stamp, and the
    // responsibility check compares the caller against the holder instead of against itself.
    const commands = createTaskCommands({
      store: live.store, registry: live.registry,
      agents: new Map([[AGENT, { as: 'scheduler' }], [other, { as: AGENT_ROLE }],
      ]),
      implementations: [{ ref: UNIT_VERIFIER, version: '1', implementationDigest: UNIT_IMPLEMENTATION }],
    })
    await commands.admit({ commandId: 'admit-parent', taskId: PARENT, contract: parentContract() })
    await commands.assign({ commandId: 'assign-parent', taskId: PARENT, agentId: AGENT })

    const stranger = await asyncRefusalOf(() => commands.forAgent(other).startRun({ purpose: 'solve', commandId: 'r-stranger', taskId: PARENT, runId: RUN, revision: pin(live) }),
    )
    expect(stranger).toMatchObject({ code: 'not-responsible', detail: expect.stringContaining(AGENT) })
    const own = await commands.forAgent(AGENT).startRun({ purpose: 'solve', commandId: 'r-own', taskId: PARENT, runId: RUN, revision: pin(live) })
    expect(own.actor).toBe(SCHEDULER)
    const strangerFail = await asyncRefusalOf(() => commands.forAgent(other).failRun({ commandId: 'f-stranger', taskId: PARENT, runId: RUN, reason: 'not mine' }),
    )
    expect(strangerFail.code).toBe<RefusalCode>('not-responsible')
    await commands.forAgent(AGENT).failRun({ commandId: 'f-own', taskId: PARENT, runId: RUN, reason: 'settled for the transfer' })

    // The holder hands the task over through its own bound surface; the previous holder cannot
    // continue the work it just gave away, and the new holder can.
    await commands.forAgent(AGENT).reassign({ commandId: 'hand-over', taskId: PARENT, from: AGENT, agentId: other })
    const previous = await asyncRefusalOf(() => commands.forAgent(AGENT).startRun({ purpose: 'solve', commandId: 'r-after', taskId: PARENT, runId: 'run-2', revision: pin(live) }),
    )
    expect(previous).toMatchObject({ code: 'not-responsible', detail: expect.stringContaining(other) })
    const taken = await commands.forAgent(other).startRun({ purpose: 'solve', commandId: 'r-new-holder', taskId: PARENT, runId: 'run-2', revision: pin(live) })
    expect(taken.actor).toBe(live.store.identityOf(AGENT_ROLE))

    // And the deployment cannot declare two executors it could never tell apart.
    const doubled = refusalOf(() => createTaskCommands({ store: live.store, registry: live.registry, agents: new Map([[AGENT, { as: 'one' }], [other, { as: 'one' }],
        ]),
        implementations: [],
      }),
    )
    expect(doubled.code).toBe<RefusalCode>('malformed-declaration')
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
      commands.startRun({ purpose: 'solve', commandId: 'r-first', taskId: CHILD, runId: 'run-a', revision: pin(live) }),
      commands.startRun({
        purpose: 'solve',
        commandId: 'r-second', taskId: CHILD, runId: 'run-b', revision: pin(live),
      }),
    ])
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])

    const state = live.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, CHILD)
    expect(Object.keys(state?.runs ?? {})).toHaveLength(1)

    const settled = fulfilled[0] as PromiseFulfilledResult<{ payload: { runId: string } }>
    const runId = settled.value.payload.runId
    await commands.openBubble({ commandId: 'b1', taskId: CHILD, runId, inputs: BUBBLE_INPUTS,
      workspace: { kind: 'dir', ref: '/counter' }, model: BUBBLE_MODEL, tools: [], conditions: [],
    })
    await reviewedVerdict(live, commands, { commandId: 'v1', taskId: CHILD, verdict: {
        reviewId: 'review-1',
        verifierRef: UNIT_VERIFIER,
        verifierVersion: '1',
        runId, criterionId: 'part',
      verdict: 'fail', implementationDigest: UNIT_IMPLEMENTATION, artifactDigest: 'b'.repeat(64), inputDigests: BUBBLE_INPUTS,
      },
    })
    await commands.settle({ commandId: 'f1', taskId: CHILD, runId })

    const spent = await asyncRefusalOf(() => commands.startRun({ purpose: 'solve', commandId: 'r-third', taskId: CHILD, runId: 'run-c', revision: pin(live) }),
    )
    expect(spent).toMatchObject({ code: 'illegal-transition', detail: expect.stringMatching(/budget exhausted.*1 of 1/),
    })
  })
})

describe('a verdict is produced by a verifier, not by an agent', () => {
  it('offers an agent no way to produce one', async () => {
    const live = await deployment()
    await openAgent(live)
    const commands = commandsFor(live)
    const asAgent = commands.forAgent(AGENT)

    // The exact surface, `recordVerdict` included in its absence: the boundary is a method the agent
    // view does not have, not a rule it is asked to respect.
    expect(Object.keys(asAgent).sort()).toEqual(['admit', 'assign',
      'decompose',
      'failRun',
      'openBubble',
      'reassign',
      'startRun',
      'submitRun',
    ])
    expect(() => commands.forAgent('agent-nobody-holds')).toThrowError(/not one this deployment holds/)
  })

  it('takes the verifier identity from the frozen criterion and refuses an unheld implementation', async () => {
    const live = await deployment()
    await openAgent(live)
    await createRevision(live)
    const commands = await planned(live)
    await commands.startRun({ purpose: 'solve', commandId: 'r1', taskId: CHILD, runId: RUN, revision: pin(live) })
    await commands.openBubble({
      commandId: 'b1',
      taskId: CHILD,
      runId: RUN,
      inputs: BUBBLE_INPUTS,
      workspace: { kind: 'git', ref: 'refs/heads/main' },
      model: BUBBLE_MODEL,
      tools: BUBBLE_TOOLS,
      conditions: BUBBLE_CONDITIONS,
    })

    const fromElsewhere = await asyncRefusalOf(() =>
      reviewedVerdict(live, commands, {
        commandId: 'v-wrong',
        taskId: CHILD,
        verdict: {
          reviewId: 'review-1',
          verifierRef: UNIT_VERIFIER,
          verifierVersion: '1',
          runId: RUN, criterionId: 'part', verdict: 'pass', implementationDigest: 'e'.repeat(64), artifactDigest: 'b'.repeat(64), inputDigests: BUBBLE_INPUTS,
        },
      }),
    )
    expect(fromElsewhere.code).toBe<RefusalCode>('unregistered-verifier')

    const recorded = await reviewedVerdict(live, commands, {
      commandId: 'v-ok',
      taskId: CHILD,
      verdict: {
        reviewId: 'review-1',
        verifierRef: UNIT_VERIFIER,
        verifierVersion: '1',
        runId: RUN, criterionId: 'part', verdict: 'pass', implementationDigest: UNIT_IMPLEMENTATION, artifactDigest: 'b'.repeat(64), inputDigests: BUBBLE_INPUTS,
      },
    })
    const evidence = recorded.payload as { verifierRef: string; verifierVersion: string; inputDigests: unknown }
    expect([evidence.verifierRef, evidence.verifierVersion, evidence.inputDigests]).toEqual([UNIT_VERIFIER, '1', BUBBLE_INPUTS,
    ])

    // A measurement cites this verdict through the reader's own lookup: the same evidence answers
    // the same digest, and a run nobody started or a criterion nobody recorded is refused by name —
    // the citation cannot name a verdict that was never recorded.
    const state = live.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, CHILD)
    if (state === undefined) throw new Error('expected the admitted child to fold')
    const citation = { runId: RUN, criterionId: 'part', artifactDigest: 'b'.repeat(64) }
    expect(recordedVerdictDigest(state, 'the citation', citation)).toBe(recordedVerdictDigest(state, 'the citation', citation),
    )
    expect(refusalOf(() => recordedVerdictDigest(state, 'the citation', { ...citation, runId: 'run-ghost' })).code,
    ).toBe<RefusalCode>('unknown-run')
    expect(refusalOf(() => recordedVerdictDigest(state, 'the citation', { ...citation, criterionId: 'nothing' })).detail,
    ).toContain('record the verdict before citing it')
  })
})

describe('the command boundary against a store that refuses', () => {
  it('refuses a command for a task that was never admitted', async () => {
    const live = await deployment()
    await createRevision(live)
    const commands = commandsFor(live)
    const refusal = await asyncRefusalOf(() => commands.startRun({ purpose: 'solve', commandId: 'r', taskId: 'task-ghost', runId: RUN, revision: pin(live) }),
    )
    expect(refusal).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('no admitted contract'),
    })
  })

  it('reports a malformed command as a refusal rather than throwing a bare error', () => {
    // The environment role must exist, or the command boundary's own facts cannot be produced.
    expect(refusalOf(() => registry().ruleFor(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, 'revision/nope')).code,
    ).toBe<RefusalCode>('unknown-kind')
    expect(() => refuse('malformed-payload', 'checked')).toThrowError(/malformed-payload/)
  })
})
