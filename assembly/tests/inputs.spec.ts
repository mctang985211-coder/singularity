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
import { loadDomain } from '../src/domain.ts'
import { contractFor } from '../src/inputs.ts'
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
  const apparatus = await openApparatus('inputs', root, domain, medium as unknown as SessionPersistence, attachmentsAt(root),
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
  const contract = contractFor(domain, template, template.goal, 'producer')
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
    const template = domain.templates.get(domain.rootTemplate)!
    await h.admit(contractFor(domain, template, template.goal))
    const apparatus = { ...h.apparatus, domain }
    const run = await startAttempt(apparatus, h.caller, 'consumer', 'consumer-run', await seedMethod(apparatus))
    expect(run.bubble!.inputs).toMatchObject([{ name: template.input.name, digest: input.digest, attachment: { attachmentId: 'sha256:' + input.digest } },
    ])
    expect(await readFile(join(workspaceOf(apparatus, 'consumer', run.runId), template.input.name))).toEqual(frozen)
  })

  it('pins the method directly and freezes the verified producer bytes without an execution Revision', async () => {
    const h = await setup()
    await h.admit(h.contract)
    const run = await startAttempt(h.apparatus, h.caller, 'consumer', 'consumer-run', await seedMethod(h.apparatus))
    const producer = taskStateOf(h.apparatus, 'producer').runs[h.producerRunId]!
    expect(run.revision).toEqual(await seedMethod(h.apparatus))
    expect(run.bubble!.inputs).toMatchObject([{ name: 'in/letters.txt', digest: producer.submission!.artifactDigest,
        attachment: producer.submission!.files.artifact,
      },
    ])
    expect(factsOf(h.medium).filter((f) => f.kind === 'revision/created')).toHaveLength(1)
    expect(await readFile(join(workspaceOf(h.apparatus, 'consumer', run.runId), 'in/letters.txt'))).toEqual(await readFile(h.artifact),
    )
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
    const root = h.domain.templates.get(h.domain.rootTemplate)!
    const contract = contractFor(h.domain, root, root.goal)
    await h.admit({ ...contract, inputs: [{ name: root.input.name, source: { kind: 'artifact', taskId: 'producer' } }],
    })
    await rejectsWithoutRun(h, 'evidence-input-mismatch')
  })

  it('rejects protected bytes different from the template reference before creating a revision or Run', async () => {
    const h = await setup()
    const template = h.domain.templates.get(h.domain.rootTemplate)!
    const contract = contractFor(h.domain, template, template.goal)
    await h.admit({ ...contract, inputs: [{ name: template.input.name,
      source: { kind: 'protected', ref: 'source', digest: 'a'.repeat(64) } }],
    })
    await rejectsWithoutRun(h, 'evidence-input-mismatch')
  })

  it('rejects another template criterion before creating a revision or Run', async () => {
    const h = await setup()
    await h.admit({ ...h.contract, criteria: [h.domain.templates.get('count-source')!.criterion] })
    await rejectsWithoutRun(h, 'evidence-input-mismatch')
  })
})
