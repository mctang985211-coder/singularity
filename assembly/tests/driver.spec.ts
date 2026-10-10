/**
 * The driver, driven through the host plugin: what one caller's tools actually commit.
 *
 * Every case here asserts facts a caller can see — the answer, the committed log, the workspace bytes —
 * and drives the real store, the real commands and the real domain over the fake medium.
 */

import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { TASK_KINDS } from '../../src/task/protocol.ts'
import { asyncRefusalOf, refusalOf } from '../../tests/fixtures.ts'
import { agentFor, execFor, factsOf, kindsOf, mount, serviceOf } from './seam.ts'

const REAL = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** The count the domain's own staged input holds — the report the criterion demands of every case. */
const LETTERS = 35
const COUNTING = "import { readFileSync } from 'node:fs'\nprocess.stdout.write(String((readFileSync(process.argv[2], 'utf8').match(/[A-Za-z]/g) ?? []).length))\n"

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function mounted(controlId = 'lib-1') {
  root = await mkdtemp(join(tmpdir(), 'assembly-ws-'))
  const { ctx, medium } = await mount({ controlId, domainDir: REAL, workspaceRoot: root })
  return { surface: serviceOf(ctx), medium, controlId, workspace: root }
}

describe('one caller through the host plugin', () => {
  it("stages the domain's own protected input, and admits the task against it", async () => {
    const { surface, medium, workspace } = await mounted()
    const agent = agentFor('agent-7', 'session-9')
    const proposal = await surface.forCall(execFor(agent, 'call-1')).propose({ goal: 'count the letters' })
    expect(kindsOf(medium)).toEqual(['agent/opened', 'task/admitted', 'task/assigned'])
    // The bytes come from the declaration, and the contract names the path they were staged to: a
    // caller supplies a goal and nothing else, so the input cannot be chosen by the model.
    const staged = await readFile(join(proposal.workspace, 'in', 'source.txt'), 'utf8')
    expect([staged, await readFile(join(REAL, 'samples', 'source.txt'), 'utf8'), proposal.workspace]).toEqual([staged, staged, join(workspace, 'tasks', proposal.taskId)])
  })

  it('opens the caller node under the role it was told to, with the real session id', async () => {
    const { surface, medium } = await mounted()
    await surface.forCall(execFor(agentFor('agent-7', 'session-9'), 'call-1')).propose({ goal: 'g' })
    expect(factsOf(medium)[0]?.payload).toMatchObject({ agentId: 'agent-7', sessionId: 'session-9', role: 'root' })
  })

  it('proposes the same goal twice as one task, committing nothing the second time', async () => {
    const { surface, medium } = await mounted()
    const call = execFor(agentFor('agent-7', 'session-9'), 'call-1')
    const first = await surface.forCall(call).propose({ goal: 'count the letters' })
    const committed = medium.events.length
    const second = await surface.forCall(execFor(agentFor('agent-7', 'session-9'), 'call-2')).propose({ goal: 'count the letters' })
    expect([second.taskId, medium.events.length]).toEqual([first.taskId, committed])
  })

  it('admits every sub-task a plan names, so the plan can actually run', async () => {
    const { surface, medium } = await mounted()
    const agent = agentFor('agent-7', 'session-9')
    const proposal = await surface.forCall(execFor(agent, 'call-1')).propose({ goal: 'count the letters' })
    // This deployment mounts no preset registry, so the plan commits and then the *session* is refused by
    // name. That is the split this case is about: the plan is a fact either way, and only starting it needs
    // a runtime that can compose a child.
    await asyncRefusalOf(() =>
      surface.forCall(execFor(agent, 'call-2')).decompose({
        taskId: proposal.taskId,
        children: [
          { key: 'first', goal: 'count them', dependsOn: [], supports: ['letters'], maxRuns: 1 },
          { key: 'second', goal: 'check the count', dependsOn: ['first'], supports: ['letters'], maxRuns: 1 },
        ],
      }),
    )
    // A plan whose children were never admitted declares work that can never start: the tree shows them
    // `missing`, never `ready`, and the plan sits there looking like a decision. So every child the plan
    // names has its own admitted, assigned task — and the ids are derived from the keys, not the keys.
    const admitted = factsOf(medium).filter(fact => fact.kind === TASK_KINDS.admitted).map(fact => fact.subject)
    const assigned = factsOf(medium).filter(fact => fact.kind === TASK_KINDS.assigned).map(fact => fact.subject)
    expect([admitted.length, admitted.every(id => id.startsWith('task-')), admitted.includes('first'), assigned.length]).toEqual([3, true, false, 3])
    // The plan's dependency names the derived id of the sibling it means, never the batch-local key.
    const plan = factsOf(medium).find(fact => fact.kind === TASK_KINDS.decomposed)
    const children = (plan?.payload as { children: readonly { taskId: string; dependsOn: readonly string[] }[] }).children
    expect([children[1]?.dependsOn, children[0]?.taskId !== 'first']).toEqual([[children[0]?.taskId], true])

    // Each sub-task belongs to the child that will do it, and that child has its own agent node.
    //
    // Assigning them to the *parent* is what made a sub-task unstartable in the real profile: the parent
    // could submit to work it had delegated while the session doing the work was refused with
    // `not-responsible` when it tried to submit its own artifact. The identity a child presents is the
    // session id derived from its task id — DSH sets an agent's `id` to the session it runs on — so the
    // assignment has to name that string, not the task id and not the parent.
    const facts = factsOf(medium)
    const openedNodes = facts.filter(fact => fact.kind === 'agent/opened').map(fact => fact.subject)
    // The parent's identity comes from the live agent, so everything else that was opened is a child.
    const parentNode = openedNodes.find(id => id.includes('agent-7'))
    const childNodes = openedNodes.filter(id => id !== parentNode)
    const holders = facts.filter(fact => fact.kind === TASK_KINDS.assigned).map(fact => (fact.payload as { agentId: string }).agentId)
    expect([holders.length, parentNode !== undefined, holders.filter(holder => holder === parentNode).length]).toEqual([3, true, 1])
    // Every holder other than the parent is a child node that was opened under its own identity, so the
    // session presenting it can act on the task it was given.
    expect(holders.filter(holder => holder !== parentNode).every(holder => childNodes.includes(holder))).toBe(true)
  })

  it('records a verified run whose verdict comes from the domain verifier', async () => {
    const { surface, medium } = await mounted()
    const call = execFor(agentFor('agent-7', 'session-9'), 'call-1')
    const proposal = await surface.forCall(call).propose({ goal: 'count the letters' })
    const answer = await surface.forCall(execFor(agentFor('agent-7', 'session-9'), 'call-2')).submit({ taskId: proposal.taskId, program: COUNTING })
    expect(answer).toMatchObject({ verdict: 'pass', phase: 'verified', artifactDigest: sha256(String(LETTERS)) })
    expect(kindsOf(medium).slice(-3)).toEqual(['bubble/opened', TASK_KINDS.evidenceProduced, TASK_KINDS.runVerified])
  })

  it('records the model route and the toolchain that actually ran in the bubble', async () => {
    const { surface, medium } = await mounted()
    const call = execFor(agentFor('agent-7', 'session-9', 'm-under-test'), 'call-1')
    const proposal = await surface.forCall(call).propose({ goal: 'g' })
    await surface.forCall(execFor(agentFor('agent-7', 'session-9', 'm-under-test'), 'call-2')).submit({ taskId: proposal.taskId, program: COUNTING })
    expect(factsOf(medium).find(fact => fact.kind === 'bubble/opened')?.payload).toMatchObject({
      model: 'test/m-under-test',
      tools: [{ name: 'node', version: process.version, implementationDigest: sha256(await readFile(process.execPath)) }],
    })
  })

  it('records a wrong answer as a fail rather than a success', async () => {
    const { surface } = await mounted()
    const call = execFor(agentFor('agent-7', 'session-9'), 'call-1')
    const proposal = await surface.forCall(call).propose({ goal: 'g' })
    const answer = await surface.forCall(execFor(agentFor('agent-7', 'session-9'), 'call-2')).submit({ taskId: proposal.taskId, program: "process.stdout.write('0')" })
    expect(answer).toMatchObject({ verdict: 'fail', phase: 'failed' })
  })

  it('records a crashing program as an empty artifact the verifier refuses', async () => {
    const { surface } = await mounted()
    const call = execFor(agentFor('agent-7', 'session-9'), 'call-1')
    const proposal = await surface.forCall(call).propose({ goal: 'g' })
    const answer = await surface.forCall(execFor(agentFor('agent-7', 'session-9'), 'call-2')).submit({ taskId: proposal.taskId, program: "process.stdout.write('5'); process.exit(3)" })
    expect([answer.verdict, answer.phase, answer.artifactDigest]).toEqual(['fail', 'failed', sha256('5')])
  })

  it('answers a redelivered call from the record and runs nothing again', async () => {
    const { surface, medium } = await mounted()
    const agent = agentFor('agent-7', 'session-9')
    const proposal = await surface.forCall(execFor(agent, 'call-1')).propose({ goal: 'g' })
    const first = await surface.forCall(execFor(agent, 'call-2')).submit({ taskId: proposal.taskId, program: COUNTING })
    const committed = medium.events.length
    await rm(join(proposal.workspace, 'program.mjs'))
    const second = await surface.forCall(execFor(agent, 'call-2')).submit({ taskId: proposal.taskId, program: COUNTING })
    await expect(readFile(join(proposal.workspace, 'program.mjs'), 'utf8')).rejects.toThrow()
    expect([second, medium.events.length]).toEqual([first, committed])
  })

  it('freezes the revision against the request, not against bytes a program can rewrite', async () => {
    const { surface, medium } = await mounted()
    const agent = agentFor('agent-7', 'session-9')
    const first = await surface.forCall(execFor(agent, 'call-1')).propose({ goal: 'g' })
    await surface.forCall(execFor(agent, 'call-2')).submit({ taskId: first.taskId, program: COUNTING })
    const second = await surface.forCall(execFor(agent, 'call-3')).propose({ goal: 'another goal' })
    await surface.forCall(execFor(agent, 'call-4')).submit({ taskId: second.taskId, program: COUNTING })
    // One revision per task, and its manifest names the task and the template — never the input bytes,
    // which a submitted program can rewrite and which therefore may not be part of any command identity.
    const manifests = factsOf(medium)
      .filter(fact => fact.kind === 'revision/created')
      .map(fact => (fact.payload as { manifest: { taskTemplate: string; task: string } }).manifest)
    expect(manifests.map(manifest => manifest.task)).toEqual([first.taskId, second.taskId])
    expect(new Set(manifests.map(manifest => manifest.taskTemplate)).size).toBe(1)
  })

  it('reads the task back with the receipt of its settled run, committing nothing', async () => {
    const { surface, medium } = await mounted()
    const agent = agentFor('agent-7', 'session-9')
    const proposal = await surface.forCall(execFor(agent, 'call-1')).propose({ goal: 'g' })
    await surface.forCall(execFor(agent, 'call-2')).submit({ taskId: proposal.taskId, program: COUNTING })
    const committed = medium.events.length
    const status = await surface.forCall(execFor(agent, 'call-3')).status({ taskId: proposal.taskId })
    expect([status.phase, status.receipt?.status, medium.events.length]).toEqual(['verified', 'verified', committed])
  })

  it("attributes the facts a caller drives to that caller's own identity", async () => {
    const { surface, medium } = await mounted()
    const agent = agentFor('agent-7', 'session-9')
    const proposal = await surface.forCall(execFor(agent, 'call-1')).propose({ goal: 'g' })
    await surface.forCall(execFor(agent, 'call-2')).submit({ taskId: proposal.taskId, program: COUNTING })
    const driven = ['task/admitted', 'task/assigned', 'run/started', 'bubble/opened']
    expect(factsOf(medium).filter(fact => driven.includes(fact.kind)).every(fact => fact.actor === 'lib-1:agent:agent-7')).toBe(true)
  })

  it('records the verdict and the settlement as apparatus acts, not the caller', async () => {
    const { surface, medium } = await mounted()
    const agent = agentFor('agent-7', 'session-9')
    const proposal = await surface.forCall(execFor(agent, 'call-1')).propose({ goal: 'g' })
    await surface.forCall(execFor(agent, 'call-2')).submit({ taskId: proposal.taskId, program: COUNTING })
    const actorOf = (kind: string) => factsOf(medium).find(fact => fact.kind === kind)?.actor
    expect([actorOf(TASK_KINDS.evidenceProduced), actorOf(TASK_KINDS.runVerified)]).toEqual(['lib-1:verifier:letters@1', 'lib-1:scheduler'])
  })

  it('lets a second agent work its own task under its own binding', async () => {
    const { surface } = await mounted()
    const mine = await surface.forCall(execFor(agentFor('agent-7', 'session-9'), 'call-1')).propose({ goal: 'g' })
    const theirs = await surface.forCall(execFor(agentFor('agent-8', 'session-10'), 'call-1')).propose({ goal: 'g' })
    const answers = await Promise.all([
      surface.forCall(execFor(agentFor('agent-7', 'session-9'), 'call-2')).submit({ taskId: mine.taskId, program: COUNTING }),
      surface.forCall(execFor(agentFor('agent-8', 'session-10'), 'call-2')).submit({ taskId: theirs.taskId, program: COUNTING }),
    ])
    // One key per agent is what makes this possible: a shared key would refuse the second agent's
    // binding outright, so neither agent could ever work a task of its own.
    expect(answers.map(answer => [answer.verdict, answer.phase])).toEqual([
      ['pass', 'verified'],
      ['pass', 'verified'],
    ])
  })

  it("refuses one agent's submission to another agent's task, by name", async () => {
    const { surface } = await mounted()
    const proposal = await surface.forCall(execFor(agentFor('agent-7', 'session-9'), 'call-1')).propose({ goal: 'g' })
    const theirs = surface.forCall(execFor(agentFor('agent-8', 'session-10'), 'call-2'))
    expect((await asyncRefusalOf(() => theirs.submit({ taskId: proposal.taskId, program: COUNTING }))).code).toBe('not-responsible')
  })

  it('writes nothing at all for a caller that is not the holder', async () => {
    const { surface, medium } = await mounted()
    const proposal = await surface.forCall(execFor(agentFor('agent-7', 'session-9'), 'call-1')).propose({ goal: 'g' })
    const committed = medium.events.length
    const theirs = surface.forCall(execFor(agentFor('agent-8', 'session-10'), 'call-2'))
    const refusal = await asyncRefusalOf(() => theirs.submit({ taskId: proposal.taskId, program: COUNTING }))
    expect([refusal.code, kindsOf(medium).slice(committed)]).toEqual(['not-responsible', []])
  })

  it('refuses a redelivery whose run is still in flight instead of running the program again', async () => {
    const { surface, medium } = await mounted()
    const agent = agentFor('agent-7', 'session-9')
    const proposal = await surface.forCall(execFor(agent, 'call-1')).propose({ goal: 'g' })
    // A program that rewrites the declared input makes the production verdict refuse the bytes it declared,
    // which leaves the run in flight — the state a submit killed mid-way leaves behind.
    const destructive = "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.argv[2], 'changed')\nprocess.stdout.write('9')"
    await asyncRefusalOf(() => surface.forCall(execFor(agent, 'call-2')).submit({ taskId: proposal.taskId, program: destructive }))
    const committed = kindsOf(medium)
    const refusal = await asyncRefusalOf(() => surface.forCall(execFor(agent, 'call-2')).submit({ taskId: proposal.taskId, program: COUNTING }))
    expect([refusal.code, kindsOf(medium), committed.includes(TASK_KINDS.runStarted)]).toEqual(['illegal-transition', committed, true])
  })

  it("refuses a read of a task the caller is not responsible for, by name", async () => {
    const { surface } = await mounted()
    const proposal = await surface.forCall(execFor(agentFor('agent-7', 'session-9'), 'call-1')).propose({ goal: 'g' })
    const theirs = surface.forCall(execFor(agentFor('agent-8', 'session-10'), 'call-2'))
    expect((await asyncRefusalOf(() => theirs.status({ taskId: proposal.taskId }))).code).toBe('not-responsible')
  })

  it('refuses a call that arrives with no agent, before it can name one', async () => {
    const { surface } = await mounted()
    expect(refusalOf(() => surface.forCall({ callId: 'call-1' } as never)).code).toBe('unknown-emitter-role')
  })

  it('refuses a submission to a task this control never admitted', async () => {
    const { surface } = await mounted()
    const agent = agentFor('agent-7', 'session-9')
    expect((await asyncRefusalOf(() => surface.forCall(execFor(agent, 'call-2')).submit({ taskId: 'task-invented', program: COUNTING }))).code).toBe('illegal-transition')
  })

  it('leaves the workspace and its bytes in place', async () => {
    const { surface } = await mounted()
    const agent = agentFor('agent-7', 'session-9')
    const proposal = await surface.forCall(execFor(agent, 'call-1')).propose({ goal: 'g' })
    await surface.forCall(execFor(agent, 'call-2')).submit({ taskId: proposal.taskId, program: COUNTING })
    expect(await readFile(join(proposal.workspace, 'report.txt'), 'utf8')).toBe(String(LETTERS))
    await expect(access(join(proposal.workspace, 'program.mjs'))).resolves.toBeUndefined()
  })
})
