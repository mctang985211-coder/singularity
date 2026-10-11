import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import type { TaskContract } from '../../src/task/contract.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { bindCaller, callerOf, openApparatus, taskStateOf } from '../src/apparatus.ts'
import { startAttempt, workspaceOf } from '../src/attempt.ts'
import { loadDomain } from '../src/domain.ts'
import { contractFor } from '../src/inputs.ts'
import { spawnProcess } from '../src/process.ts'
import { submit } from '../src/submission.ts'
import { agentFor, execFor, factsOf, fakeExecution, FakePersistence } from './seam.ts'

const domainDir = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const EXTRACT = "import { readFileSync } from 'node:fs'; process.stdout.write((readFileSync(process.argv[2], 'utf8').match(/[A-Za-z]/g) ?? []).join(''))"
const COUNT = "import { readFileSync } from 'node:fs'; process.stdout.write(String((readFileSync(process.argv[2], 'utf8').match(/[A-Za-z]/g) ?? []).length))"

async function setup(producerTemplate = 'extract-letters', verified = true) {
  const root = await mkdtemp(join(tmpdir(), 'assembly-inputs-'))
  roots.push(root)
  const medium = new FakePersistence()
  const domain = await loadDomain(domainDir, spawnProcess)
  const apparatus = await openApparatus('inputs', root, domain, medium as unknown as SessionPersistence)
  const agent = agentFor('executor', 'executor-session')
  const caller = callerOf(agent)
  await bindCaller(apparatus, caller)
  const commands = apparatus.tasks.forAgent(caller.agentId)
  const producer = domain.templates.get(producerTemplate)!
  await commands.admit({ commandId: 'admit-producer', taskId: 'producer', contract: contractFor(domain, producer, producer.goal) })
  await commands.assign({ commandId: 'assign-producer', taskId: 'producer', agentId: caller.agentId })
  const run = await startAttempt(apparatus, caller, 'producer', 'producer-run')
  if (verified) {
    const exec = execFor(agent, 'submit-producer')
    const result = await submit(apparatus, fakeExecution(() => undefined), caller, exec,
      { taskId: 'producer', program: producerTemplate === 'extract-letters' ? EXTRACT : COUNT }, new AbortController().signal)
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
  await expect(startAttempt(h.apparatus, h.caller, 'consumer', 'consumer-run')).rejects.toMatchObject({
    refusal: { code },
  })
  expect(factsOf(h.medium)).toEqual(before)
  expect(Object.keys(taskStateOf(h.apparatus, 'consumer').runs)).toEqual([])
}

describe('template input binding before a Run or input revision exists', () => {
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
    const run = await startAttempt(apparatus, h.caller, 'consumer', 'consumer-run')
    expect(run.bubble!.inputs).toEqual([{ name: template.input.name, digest: input.digest }])
    expect(await readFile(join(workspaceOf(apparatus, 'consumer', run.runId), template.input.name))).toEqual(frozen)
  })

  it('pins the verified producer Run and exact bytes in the consumer revision and workspace', async () => {
    const h = await setup()
    await h.admit(h.contract)
    const run = await startAttempt(h.apparatus, h.caller, 'consumer', 'consumer-run')
    const revision = h.apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, 'inputs')!
      .revisions[run.revision.revisionId]!
    const producer = taskStateOf(h.apparatus, 'producer').runs[h.producerRunId]!
    expect(revision.manifest).toMatchObject({ task: 'consumer', taskTemplate: h.contract.template,
      inputSources: [{ name: 'in/letters.txt', digest: producer.submission!.artifactDigest,
        source: { kind: 'artifact', taskId: 'producer', runId: h.producerRunId } }] })
    expect(await readFile(join(workspaceOf(h.apparatus, 'consumer', run.runId), 'in/letters.txt'))).toEqual(await readFile(h.artifact))
  })

  it('rejects an unverified producer without creating a revision or Run', async () => {
    const h = await setup('extract-letters', false)
    await h.admit(h.contract)
    await rejectsWithoutRun(h, 'illegal-transition')
  })

  it('rejects a changed verified artifact without creating a revision or Run', async () => {
    const h = await setup()
    await h.admit(h.contract)
    await writeFile(h.artifact, 'changed')
    await rejectsWithoutRun(h, 'evidence-input-mismatch')
  })

  it('rejects a missing verified artifact without creating a revision or Run', async () => {
    const h = await setup()
    await h.admit(h.contract)
    await rm(h.artifact)
    await rejectsWithoutRun(h, 'evidence-input-mismatch')
  })

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
    await h.admit({ ...h.contract, inputs: [{ name: 'in/letters.txt', source: { kind: 'protected', ref: input.ref, digest: input.digest } }] })
    await rejectsWithoutRun(h, 'evidence-input-mismatch')
  })

  it('rejects an artifact substituted for the template protected source before creating a revision or Run', async () => {
    const h = await setup()
    const root = h.domain.templates.get(h.domain.rootTemplate)!
    const contract = contractFor(h.domain, root, root.goal)
    await h.admit({ ...contract, inputs: [{ name: root.input.name, source: { kind: 'artifact', taskId: 'producer' } }] })
    await rejectsWithoutRun(h, 'evidence-input-mismatch')
  })

  it('rejects protected bytes different from the template reference before creating a revision or Run', async () => {
    const h = await setup()
    const template = h.domain.templates.get(h.domain.rootTemplate)!
    const contract = contractFor(h.domain, template, template.goal)
    await h.admit({ ...contract, inputs: [{ name: template.input.name,
      source: { kind: 'protected', ref: 'source', digest: 'a'.repeat(64) } }] })
    await rejectsWithoutRun(h, 'evidence-input-mismatch')
  })

  it('rejects another template criterion before creating a revision or Run', async () => {
    const h = await setup()
    await h.admit({ ...h.contract, criteria: [h.domain.templates.get('count-source')!.criterion] })
    await rejectsWithoutRun(h, 'evidence-input-mismatch')
  })
})
