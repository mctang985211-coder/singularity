import { testProjections } from './seam.ts'
import { seedMethod } from '../src/method.ts'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import type { TaskContract } from '../../src/task/contract.ts'
import { bindCaller, callerOf, openApparatus, taskStateOf } from '../src/apparatus.ts'
import { startAttempt, workspaceOf } from '../src/attempt.ts'
import { readForAgent } from '../src/read.ts'
import { loadDomain } from '../src/domain.ts'
import { assertTemplateContract, contractFor } from '../src/inputs.ts'
import { readTemplate, templateDeclaration } from '../src/template.ts'
import { sha256 } from '../src/ids.ts'
import { spawnProcess } from '../src/process.ts'
import { fixtureReview } from './review-fixture.ts'
import { submit } from '../src/submission.ts'
import { attachmentsAt, agentFor, execFor, factsOf, fakeExecution, FakePersistence } from './seam.ts'

const domainDir = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function setup(producerTemplate = 'extract-letters', verified = true) {
  const root = await mkdtemp(join(tmpdir(), 'assembly-inputs-'))
  roots.push(root)
  const medium = new FakePersistence()
  const domain = await loadDomain(domainDir, spawnProcess)
  const apparatus = await openApparatus('inputs', root, domain, medium as unknown as SessionPersistence, attachmentsAt(root), testProjections,
  )
  const agent = agentFor('executor', 'executor-session')
  const caller = callerOf(agent)
  await bindCaller(apparatus, caller)
  const commands = apparatus.tasks.forAgent(caller.agentId)
  const producer = domain.templates.get(producerTemplate)!
  await commands.admit({ commandId: 'admit-producer', taskId: 'producer', contract: contractFor(domain, producer, producer.goal),
  })
  await commands.assign({ commandId: 'assign-producer', taskId: 'producer', agentId: caller.agentId })
  const run = await startAttempt(apparatus, caller, 'producer', 'producer-run', await seedMethod(apparatus))
  if (verified) {
    const exec = execFor(agent, 'submit-producer')
    await writeFile(
      join(run.bubble!.workspace.ref, producer.artifact),
      producerTemplate === 'extract-letters'
        ? Buffer.from(domain.inputs[0]!.bytes)
            .toString()
            .match(/[A-Za-z]/g)!
            .join('')
        : '35',
    )
    const result = await submit(apparatus, fakeExecution(() => undefined), caller, exec,
      { taskId: 'producer', path: producer.artifact },
      new AbortController().signal,
      fixtureReview(apparatus),
    )
    expect(result.verdict).toBe('pass')
  }
  const template = domain.templates.get('count-letters')!
  const contract = contractFor(domain, template, template.goal, new Map([['extract-letters', 'producer']]))
  const admit = async (value: TaskContract) => {
    await commands.admit({ commandId: 'admit-consumer', taskId: 'consumer', contract: value })
    await commands.assign({ commandId: 'assign-consumer', taskId: 'consumer', agentId: caller.agentId })
  }
  const artifact = join(workspaceOf(apparatus, 'producer', run.runId), producer.artifact)
  return { apparatus, medium, domain, caller, contract, admit, artifact, producerRunId: run.runId }
}

async function rejectsWithoutRun(h: Awaited<ReturnType<typeof setup>>, code: string) {
  const before = factsOf(h.medium)
  await expect(startAttempt(h.apparatus, h.caller, 'consumer', 'consumer-run', await seedMethod(h.apparatus)),
  ).rejects.toMatchObject({
    refusal: { code },
  })
  expect(factsOf(h.medium)).toEqual(before)
  expect(Object.keys(taskStateOf(h.apparatus, 'consumer').runs)).toEqual([])
}

describe('template input binding and sealed preparation', () => {
  it('uses loader-sealed protected bytes after the domain source file changes', async () => {
    const h = await setup()
    const input = h.domain.inputs[0]!
    const frozen = Buffer.from(input.bytes)
    const temporaryDir = join(h.apparatus.workspaceRoot, 'domain')
    const sourcePath = join(temporaryDir, input.sourcePath)
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, frozen)
    const domain = { ...h.domain, dir: temporaryDir }
    await writeFile(sourcePath, 'changed after the loader sealed its input')
    expect(await readFile(sourcePath)).not.toEqual(frozen)
    const template = domain.templates.get(domain.rootTemplate!)!
    await h.admit(contractFor(domain, template, template.goal))
    const apparatus = { ...h.apparatus, domain }
    const run = await startAttempt(apparatus, h.caller, 'consumer', 'consumer-run', await seedMethod(apparatus))
    expect(run.bubble!.inputs).toMatchObject([{ name: template.inputs[0]!.name, digest: input.digest, attachment: { attachmentId: 'sha256:' + input.digest } },
    ])
    expect(await readFile(join(workspaceOf(apparatus, 'consumer', run.runId), template.inputs[0]!.name))).toEqual(frozen)
  })

  it('pins the method directly and freezes the verified producer bytes without an execution Revision', async () => {
    const h = await setup()
    await h.admit(h.contract)
    const run = await startAttempt(h.apparatus, h.caller, 'consumer', 'consumer-run', await seedMethod(h.apparatus))
    const producer = taskStateOf(h.apparatus, 'producer').runs[h.producerRunId]!
    expect(run.revision).toEqual(await seedMethod(h.apparatus))
    expect(run.bubble!.inputs).toMatchObject([{ name: 'in/letters.txt', digest: producer.submission!.artifactDigest,
        producerRunId: h.producerRunId,
        attachment: producer.submission!.files.artifact,
      },
    ])
    expect(factsOf(h.medium).filter((f) => f.kind === 'revision/created')).toHaveLength(1)
    expect(await readFile(join(workspaceOf(h.apparatus, 'consumer', run.runId), 'in/letters.txt'))).toEqual(await readFile(h.artifact),
    )
  })

  it('reads the current complete template contract without rebinding its producer or dropping added criteria', async () => {
    const h = await setup()
    const contract = { ...h.contract, goal: 'Count the chosen producer under the additional bound',
      criteria: [...h.contract.criteria, { criterionId: 'bounded', statement: 'The count is between zero and 100.' }] }
    await h.admit(contract)
    await startAttempt(h.apparatus, h.caller, 'consumer', 'consumer-run', await seedMethod(h.apparatus))
    const read = await readForAgent(h.apparatus, h.caller.agentId, { kind: 'template', ref: 'count-letters' })
    expect(read).toMatchObject({ contract })
    expect((read as { contract: TaskContract }).contract).toEqual(contract)
    const catalog = await readForAgent(h.apparatus, h.caller.agentId, { kind: 'template' })
    expect(catalog).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'count-letters', producers: ['extract-letters'] })]))
    await h.apparatus.store.close()
  })

  it('rejects an unverified producer without creating a revision or Run', async () => {
    const h = await setup('extract-letters', false)
    await h.admit(h.contract)
    await rejectsWithoutRun(h, 'illegal-transition')
  })

  it('uses the sealed producer bytes after its editable artifact changes', async () => {
    const h = await setup()
    await h.admit(h.contract)
    const sealed = await readFile(h.artifact)
    await writeFile(h.artifact, 'changed')
    const run = await startAttempt(h.apparatus, h.caller, 'consumer', 'consumer-run', await seedMethod(h.apparatus))
    expect(await readFile(join(workspaceOf(h.apparatus, 'consumer', run.runId), 'in/letters.txt'))).toEqual(sealed)
  })

  it('uses the sealed producer bytes after its editable artifact is removed', async () => {
    const h = await setup()
    await h.admit(h.contract)
    const sealed = await readFile(h.artifact)
    await rm(h.artifact)
    const run = await startAttempt(h.apparatus, h.caller, 'consumer', 'consumer-run', await seedMethod(h.apparatus))
    expect(await readFile(join(workspaceOf(h.apparatus, 'consumer', run.runId), 'in/letters.txt'))).toEqual(sealed)
  })

  it.each(['missing', 'corrupt'] as const)('records a runtime preparation failure when the sealed producer object is %s', async (damage) => {
    const h = await setup()
    await h.admit(h.contract)
    const producer = taskStateOf(h.apparatus, 'producer').runs[h.producerRunId]!
    const ref = producer.submission!.files.artifact
    const path = attachmentsAt(h.apparatus.workspaceRoot).fileHostPath(ref)
    if (damage === 'missing') await rm(path)
    else {
      await chmod(path, 0o600)
      await writeFile(path, Buffer.alloc(ref.bytes, 120))
    }
    await expect(startAttempt(h.apparatus, h.caller, 'consumer', 'consumer-run', await seedMethod(h.apparatus)),
      ).rejects.toMatchObject({
      code: damage === 'missing' ? 'ATTACHMENT_NOT_FOUND' : 'ATTACHMENT_CORRUPT',
    })
    expect(Object.values(taskStateOf(h.apparatus, 'consumer').runs)).toMatchObject([{ status: 'failed', failureCause: 'runtime' },
      ])
    },
  )

  it('rejects a verified producer of another template before creating a revision or Run', async () => {
    const h = await setup('count-source')
    await h.admit(h.contract)
    await rejectsWithoutRun(h, 'evidence-input-mismatch')
  })

  it('rejects a contract input name different from its template before creating a revision or Run', async () => {
    const h = await setup()
    await h.admit({ ...h.contract, inputs: [{ ...h.contract.inputs[0]!, name: 'in/other.txt' }] })
    await rejectsWithoutRun(h, 'evidence-input-mismatch')
  })

  it('rejects protected bytes substituted for the template artifact source before creating a revision or Run', async () => {
    const h = await setup()
    const input = h.domain.inputs[0]!
    await h.admit({ ...h.contract, inputs: [{ name: 'in/letters.txt', source: { kind: 'protected', ref: input.ref, digest: input.digest } }],
    })
    await rejectsWithoutRun(h, 'evidence-input-mismatch')
  })

  it('rejects an artifact substituted for the template protected source before creating a revision or Run', async () => {
    const h = await setup()
    const root = h.domain.templates.get(h.domain.rootTemplate!)!
    const contract = contractFor(h.domain, root, root.goal)
    await h.admit({ ...contract, inputs: [{ name: root.inputs[0]!.name, source: { kind: 'artifact', taskId: 'producer' } }],
    })
    await rejectsWithoutRun(h, 'evidence-input-mismatch')
  })

  it('rejects protected bytes different from the template reference before creating a revision or Run', async () => {
    const h = await setup()
    const template = h.domain.templates.get(h.domain.rootTemplate!)!
    const contract = contractFor(h.domain, template, template.goal)
    await h.admit({ ...contract, inputs: [{ name: template.inputs[0]!.name,
      source: { kind: 'protected', ref: 'source', digest: 'a'.repeat(64) } }],
    })
    await rejectsWithoutRun(h, 'evidence-input-mismatch')
  })

  it('rejects another template criterion before creating a revision or Run', async () => {
    const h = await setup()
    await h.admit({ ...h.contract, criteria: h.domain.templates.get('count-source')!.criteria })
    await rejectsWithoutRun(h, 'evidence-input-mismatch')
  })

  it('freezes additional child standards in the same contract while retaining every protected standard', async () => {
    const h = await setup()
    const contract = { ...h.contract, goal: 'Count and explain the verified extraction', criteria: [
      ...h.contract.criteria, { criterionId: 'explanation', statement: 'Explain the counted source with a reproducible finding' },
    ] }
    expect(assertTemplateContract(h.domain, contract)?.id).toBe('count-letters')
    await h.admit(contract)
    await startAttempt(h.apparatus, h.caller, 'consumer', 'consumer-run', await seedMethod(h.apparatus))
    expect(taskStateOf(h.apparatus, 'consumer').contract).toEqual(contract)
    expect(() => assertTemplateContract(h.domain, { ...contract, criteria: contract.criteria.slice(1) }))
      .toThrow('pinned template')
    await h.apparatus.store.close()
  })

  it('runs every pinned check against its named input, even when inputs have different contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assembly-multiple-checks-'))
    roots.push(root)
    const original = await loadDomain(domainDir, spawnProcess)
    const secondBytes = Buffer.from('a!')
    const inputs = [...original.inputs, { ref: 'second', sourcePath: 'second.txt', bytes: secondBytes, digest: sha256(secondBytes) }]
    const declared = templateDeclaration(original.templates.get(original.rootTemplate!)!)
    const template = await readTemplate(original.dir, { ...declared, id: 'two-checks',
      inputs: [...declared.inputs, { name: 'in/second.txt', source: { kind: 'protected', ref: 'second' } }],
      criteria: [...declared.criteria, { criterionId: 'second-count', statement: 'the report also equals the count of the second input' }],
      checks: [...declared.checks, { criterionId: 'second-count', verifier: 'letters', input: 'in/second.txt' }],
    }, original.verifiers, 'two-checks')
    const domain = { ...original, inputs, templates: new Map([...original.templates, [template.id, template]]) }
    const medium = new FakePersistence()
    const apparatus = await openApparatus('checks', root, domain, medium as unknown as SessionPersistence, attachmentsAt(root), testProjections)
    const agent = agentFor('executor', 'executor-session'), caller = callerOf(agent)
    await bindCaller(apparatus, caller)
    const commands = apparatus.tasks.forAgent(caller.agentId)
    await commands.admit({ commandId: 'admit', taskId: 'two-checks', contract: contractFor(domain, template, template.goal) })
    await commands.assign({ commandId: 'assign', taskId: 'two-checks', agentId: caller.agentId })
    const run = await startAttempt(apparatus, caller, 'two-checks', 'run', await seedMethod(apparatus))
    const count = (Buffer.from(original.inputs[0]!.bytes).toString('utf8').match(/[A-Za-z]/g) ?? []).length
    await writeFile(join(run.bubble!.workspace.ref, template.artifact), String(count))
    const result = await submit(apparatus, fakeExecution(() => undefined), caller, execFor(agent, 'submit'),
      { taskId: 'two-checks', path: template.artifact }, new AbortController().signal, fixtureReview(apparatus))
    expect(result.verdict).toBe('fail')
    const evidence = taskStateOf(apparatus, 'two-checks').runs[run.runId]!.evidence
    expect(evidence.map(({ criterionId, verdict }) => [criterionId, verdict])).toEqual([['letters', 'pass'], ['second-count', 'fail']])
    const checks = JSON.parse(evidence[0]!.detail!).checks
    expect(checks.map((check: { inputDigests: { name: string }[] }) => check.inputDigests.map(input => input.name)))
      .toEqual([['in/source.txt'], ['in/second.txt']])
    await apparatus.store.close()
  })
})
