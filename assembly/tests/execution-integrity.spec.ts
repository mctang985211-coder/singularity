import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { asyncRefusalOf } from '../../tests/fixtures.ts'
import { agentFor, execFor, factsOf, mount, serviceOf } from './seam.ts'
import { callerOf } from '../src/apparatus.ts'
import { propose } from '../src/surfaces.ts'

const domainDir = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const counting = "import { readFileSync } from 'node:fs'; process.stdout.write(String((readFileSync(process.argv[2], 'utf8').match(/[A-Za-z]/g) ?? []).length))"
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function setup(domain = domainDir) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'assembly-integrity-'))
  roots.push(workspaceRoot)
  const { ctx, medium, apparatus } = await mount({ controlId: 'integrity', domainDir: domain, workspaceRoot })
  const agent = agentFor('worker', 'worker-session')
  const service = serviceOf(ctx)
  const call = (id: string) => service.forCall(execFor(agent, id))
  const caller = callerOf(agent)
  const proposal = await propose(apparatus, caller, 'propose', { goal: 'count letters' })
  return { call, proposal, medium, apparatus, caller }
}

describe('complete solve and immutable submission', () => {
  it('starts the Run before the caller solves or submits', async () => {
    const { call, proposal, medium } = await setup()
    expect(factsOf(medium).filter(fact => fact.kind === 'run/started')).toHaveLength(1)
    expect(await call('status').status({ taskId: proposal.taskId })).toMatchObject({ phase: 'running', runs: 1, receipt: null })
  })

  it('rejects a submission symlink before the host can overwrite another Run or input', async () => {
    const { call, proposal } = await setup()
    const protectedFile = join(proposal.workspace, 'protected.txt')
    await writeFile(protectedFile, 'unchanged')
    await symlink(protectedFile, join(proposal.workspace, 'program.mjs'))
    await expect(call('submit').submit({ taskId: proposal.taskId, program: counting })).rejects.toThrow('symbolic link')
    expect(await readFile(protectedFile, 'utf8')).toBe('unchanged')
  })

  it('rejects a new solve request while that Task already has a working Run', async () => {
    const { call, medium, proposal } = await setup()
    const committed = medium.events.length
    expect((await asyncRefusalOf(() => call('retry').retry({ taskId: proposal.taskId }))).code).toBe('illegal-transition')
    expect(medium.events.length).toBe(committed)
  })

  it('rejects a changed goal on the retry boundary before preparing another Task', async () => {
    const { call, medium, proposal } = await setup()
    const committed = medium.events.length
    expect((await asyncRefusalOf(() => call('retry').retry({ taskId: proposal.taskId, goal: 'changed' } as never))).code).toBe('malformed-declaration')
    expect(medium.events.length).toBe(committed)
  })

  it('fails correct stdout when the producing process exits nonzero', async () => {
    const { call, proposal, medium } = await setup()
    const answer = await call('submit').submit({ taskId: proposal.taskId, program: "process.stdout.write('35'); process.exit(3)" })
    expect(answer).toMatchObject({ verdict: 'unknown', phase: 'failed' })
    expect(answer.detail).toContain('3')
    expect(factsOf(medium).some(fact => fact.kind === 'run/verified')).toBe(false)
    expect((await call('status').status({ taskId: proposal.taskId })).receipt).toMatchObject({
      source: { sessionId: 'worker-session' }, submission: { executionFailure: expect.stringContaining('3') },
    })
  })

  it('records a verification runtime failure instead of leaving the sealed Run running', async () => {
    const domain = await mkdtemp(join(tmpdir(), 'assembly-verifier-'))
    roots.push(domain)
    await cp(domainDir, domain, { recursive: true })
    const { call, proposal, medium } = await setup(domain)
    await rm(join(domain, 'verifier.mjs'))
    await expect(call('submit').submit({ taskId: proposal.taskId, program: counting })).rejects.toThrow('unregistered-verifier')
    expect(await call('status').status({ taskId: proposal.taskId })).toMatchObject({ phase: 'failed' })
    expect(factsOf(medium).find(fact => fact.kind === 'run/failed')).toMatchObject({
      payload: { runId: proposal.runId, reason: expect.stringContaining('verification-failed') },
    })
  })

  it('refuses changed content on redelivery without writing facts or files', async () => {
    const { call, proposal, medium } = await setup()
    await call('submit').submit({ taskId: proposal.taskId, program: counting })
    const committed = medium.events.length
    expect((await asyncRefusalOf(() => call('submit').submit({ taskId: proposal.taskId, program: "process.stdout.write('0')" }))).code).toBe('command-conflict')
    expect(medium.events.length).toBe(committed)
  })

  it('allows only one concurrent submission to touch a Run', async () => {
    const { call, proposal } = await setup()
    const requests = await Promise.allSettled([
      call('first').submit({ taskId: proposal.taskId, program: counting }),
      call('second').submit({ taskId: proposal.taskId, program: counting + '\n' }),
    ])
    expect(requests.filter(request => request.status === 'fulfilled')).toMatchObject([{ value: { verdict: 'pass' } }])
    expect(requests.filter(request => request.status === 'rejected')).toHaveLength(1)
  })

  it('executes a concurrently redelivered submission only once', async () => {
    const { call, proposal, medium } = await setup()
    const counter = join(proposal.workspace, 'executions.txt')
    const program = `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(counter)}, ${JSON.stringify('execution\n')}); ${counting}`
    const request = { taskId: proposal.taskId, program }
    const answers = await Promise.allSettled([
      call('same-submit').submit(request),
      call('same-submit').submit(request),
    ])
    expect(await readFile(counter, 'utf8')).toBe('execution\n')
    const successful = answers.find(answer => answer.status === 'fulfilled')!
    expect(successful).toMatchObject({ value: { verdict: 'pass' } })
    expect(answers.filter(answer => answer.status === 'rejected')).toMatchObject([{ reason: { refusal: { code: 'illegal-transition' } } }])
    const count = medium.events.length
    expect(await call('same-submit').submit(request)).toEqual(successful.value)
    expect(medium.events.length).toBe(count)
  })

  it('keeps a receipt fixed after another Task is admitted', async () => {
    const { call, proposal, apparatus, caller } = await setup()
    await call('submit').submit({ taskId: proposal.taskId, program: counting })
    const before = await call('status').status({ taskId: proposal.taskId })
    await propose(apparatus, { ...caller, agentId: 'other', sessionId: 'other-session' }, 'other', { goal: 'another human task' })
    expect(await call('status').status({ taskId: proposal.taskId })).toEqual(before)
  })

  it('returns identical content from the recorded result after its files are deleted', async () => {
    const { call, proposal, medium } = await setup()
    const first = await call('submit').submit({ taskId: proposal.taskId, program: counting })
    const committed = medium.events.length
    await rm(proposal.workspace, { recursive: true })
    expect(await call('submit').submit({ taskId: proposal.taskId, program: counting })).toEqual(first)
    expect(medium.events.length).toBe(committed)
  })

  it('retains the exact submitted program and source in the formal receipt', async () => {
    const { call, proposal } = await setup()
    await call('submit').submit({ taskId: proposal.taskId, program: counting })
    const status = await call('status').status({ taskId: proposal.taskId })
    expect(status.receipt).toMatchObject({ source: { sessionId: 'worker-session' }, submission: { requestId: expect.any(String) } })
    expect(await readFile(join(proposal.workspace, 'program.mjs'), 'utf8')).toBe(counting)
  })
})
