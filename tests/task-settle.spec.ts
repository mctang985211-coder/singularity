/**
 * The run's settlement, as the trusted command surface produces it.
 *
 * `settle` is where the run's outcome becomes a fact: the evidence decides which kind it is — no
 * verdict at all from a criterion's own verifier refuses, every criterion passing verifies, anything
 * else fails with the failing verdict's detail. The check runs inside the store's serial region, and
 * the producer reads the run's **evidence** rather than its status, so a redelivered command
 * recomputes the identical request and the store answers it from the fact it already committed.
 */

import { describe, expect, it } from 'vitest'

import { AGENT_ROLE, createTaskCommands, TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../src/index.ts'
import { asyncRefusalOf } from './fixtures.ts'
import { AGENT, createRevision, deployment, openAgent, PARENT, pin, RUN, type Deployment } from './command-fixtures.ts'
import {
  ARTIFACT,
  BUBBLE_CONDITIONS,
  BUBBLE_INPUTS,
  BUBBLE_MODEL,
  BUBBLE_TOOLS,
  contract,
  INTEGRATION_IMPLEMENTATION,
  INTEGRATION_VERIFIER,
  SCHEDULER,
  UNIT_IMPLEMENTATION,
  UNIT_VERIFIER,
} from './task-fixtures.ts'

/** The trusted surface, as its factory returns it. */
type Commands = ReturnType<typeof createTaskCommands>

/** A task with an admitted two-criterion contract, a responsible agent, one running run and a bubble. */
async function running(live: Deployment): Promise<Commands> {
  const commands = createTaskCommands({
    store: live.store,
    registry: live.registry,
    agents: new Map([[AGENT, { as: 'scheduler' }]]),
    implementations: [
      { ref: UNIT_VERIFIER, version: '1', implementationDigest: UNIT_IMPLEMENTATION },
      { ref: INTEGRATION_VERIFIER, version: '1', implementationDigest: INTEGRATION_IMPLEMENTATION },
    ],
  })
  await commands.admit({ commandId: 'admit', taskId: PARENT, contract: contract() })
  await commands.assign({ commandId: 'assign', taskId: PARENT, agentId: AGENT })
  await commands.startRun({ commandId: 'start', taskId: PARENT, runId: RUN, revision: pin(live) })
  await commands.openBubble({
    commandId: 'bubble',
    taskId: PARENT,
    runId: RUN,
    inputs: BUBBLE_INPUTS,
    workspace: { kind: 'git', ref: 'refs/heads/main' },
    model: BUBBLE_MODEL,
    tools: BUBBLE_TOOLS,
    conditions: BUBBLE_CONDITIONS,
  })
  return commands
}

/** One verdict for one criterion, from the implementation that criterion names. */
async function judge(commands: Commands, criterionId: string, verdict: 'pass' | 'fail', detail?: string): Promise<void> {
  await commands.recordVerdict({
    commandId: `verdict-${criterionId}-${verdict}`,
    taskId: PARENT,
    verdict: {
      runId: RUN,
      criterionId,
      verdict,
      implementationDigest: criterionId === 'correctness' ? UNIT_IMPLEMENTATION : INTEGRATION_IMPLEMENTATION,
      artifactDigest: ARTIFACT,
      inputDigests: BUBBLE_INPUTS,
      ...(detail === undefined ? {} : { detail }),
    },
  })
}

const runOf = (live: Deployment) => live.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, PARENT)?.runs[RUN]

/** A deployment with an opened agent, a created revision and a task ready to run. */
async function ready(): Promise<{ live: Deployment; commands: Commands }> {
  const live = await deployment()
  await openAgent(live)
  await createRevision(live)
  return { live, commands: await running(live) }
}

describe('the settle command decides the run from its evidence', () => {
  it('settles the run verified under the scheduler, whatever binding the caller passes', async () => {
    const { live, commands } = await ready()
    await judge(commands, 'correctness', 'pass')
    await judge(commands, 'limits', 'pass')

    // The verified branch is the apparatus's own fact, so the scheduler's role stamps it even when
    // the caller hands a binding of its own. The failed branch below is the one that uses it.
    const settled = await commands.settle({ commandId: 'settle-1', taskId: PARENT, runId: RUN }, AGENT_ROLE)

    expect([settled.kind, settled.actor, runOf(live)?.status]).toEqual([TASK_KINDS.runVerified, SCHEDULER, 'verified'])
  })

  it('settles the run failed under the responsible binding, carrying the failing verdict detail', async () => {
    const { live, commands } = await ready()
    await judge(commands, 'correctness', 'pass')
    await judge(commands, 'limits', 'fail', 'the artifact claims 4 letters; the input holds 5')

    const settled = await commands.settle({ commandId: 'settle-1', taskId: PARENT, runId: RUN }, 'scheduler')

    expect([settled.kind, (settled.payload as { reason?: string }).reason, runOf(live)?.status]).toEqual([
      TASK_KINDS.runFailed,
      'the artifact claims 4 letters; the input holds 5',
      'failed',
    ])
  })

  it('refuses while a criterion has no verdict from its own verifier, and records nothing', async () => {
    const { live, commands } = await ready()
    await judge(commands, 'correctness', 'pass')
    const recorded = live.store.load().entries().length

    const refusal = await asyncRefusalOf(() => commands.settle({ commandId: 'settle-1', taskId: PARENT, runId: RUN }))

    expect([refusal.code, runOf(live)?.status, live.store.load().entries().length]).toEqual(['unadjudicated-criterion', 'running', recorded])
  })

  it('refuses a run the task never started', async () => {
    const { commands } = await ready()

    const refusal = await asyncRefusalOf(() => commands.settle({ commandId: 'settle-ghost', taskId: PARENT, runId: 'run-ghost' }))

    expect(refusal.code).toBe('unknown-run')
  })

  it('refuses a different settle command once the run has settled', async () => {
    const { commands } = await ready()
    await judge(commands, 'correctness', 'pass')
    await judge(commands, 'limits', 'pass')
    await commands.settle({ commandId: 'settle-1', taskId: PARENT, runId: RUN })

    const refusal = await asyncRefusalOf(() => commands.settle({ commandId: 'settle-2', taskId: PARENT, runId: RUN }))

    expect(refusal.code).toBe('illegal-transition')
  })

  it('is decided inside the commit region, so it sees the verdict queued ahead of it', async () => {
    const { live, commands } = await ready()
    await judge(commands, 'correctness', 'pass')

    // Both are submitted in one turn, so the verdict is queued first and this settlement second. The
    // settlement is decided against the state that first commit left — which is the whole of "the
    // check runs in the serial region": a decision taken before queueing would find the criterion
    // unadjudicated and refuse a run that is in fact settled.
    const [, settled] = await Promise.all([
      judge(commands, 'limits', 'pass'),
      commands.settle({ commandId: 'settle-1', taskId: PARENT, runId: RUN }),
    ])

    expect([settled.kind, runOf(live)?.status]).toEqual([TASK_KINDS.runVerified, 'verified'])
  })

  it('answers a redelivered settle with the fact it already committed, and appends nothing', async () => {
    const { live, commands } = await ready()
    await judge(commands, 'correctness', 'pass')
    await judge(commands, 'limits', 'pass')
    const first = await commands.settle({ commandId: 'settle-1', taskId: PARENT, runId: RUN })
    const recorded = live.store.load().entries().length

    // The reply was lost, so the caller re-delivers. The run is no longer running, but the producer
    // recomputes from the evidence, so the store recognizes the command and returns its fact.
    const again = await commands.settle({ commandId: 'settle-1', taskId: PARENT, runId: RUN })

    expect([again.digest, again.seq, live.store.load().entries().length]).toEqual([first.digest, first.seq, recorded])
  })

  it('refuses a failed settle emitted under a binding that is not the responsible agent', async () => {
    const { live, commands } = await ready()
    await judge(commands, 'correctness', 'fail', 'the count is wrong')
    await judge(commands, 'limits', 'pass')
    const recorded = live.store.load().entries().length

    // The binding is a held identity that is not the task's holder. Nothing here compares it: the
    // reducer's own responsibility rule refuses the fact, and nothing is recorded.
    const refusal = await asyncRefusalOf(() => commands.settle({ commandId: 'settle-1', taskId: PARENT, runId: RUN }, AGENT_ROLE))

    expect([refusal.code, live.store.load().entries().length]).toEqual(['not-responsible', recorded])
  })
})
