import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, it } from 'vitest'
import { digestOf } from '../../src/protocol/envelope.ts'
import { MemoryLog } from '../../src/protocol/memory-log.ts'
import type { RunSubmission } from '../../src/task/run.ts'
import type { SchedulerMessageSource } from '../src/scheduler-message.ts'
import { sha256 } from '../src/ids.ts'
import { admitted, contract, SUBJECTS, TASK_ID, taskRegistry } from '../../tests/task-fixtures.ts'
const scriptPath = fileURLToPath(new URL('../../scripts/browser-probe.mjs', import.meta.url))
const { inputSourcesOf, toolFacts, assertPlannedTasks, coreRead, sealedDigestsOf, schedulerEvidenceOf }: {
  inputSourcesOf(facts: readonly unknown[], taskId: string, receipt: unknown): unknown
  toolFacts(events: readonly unknown[]): { results: readonly { value: unknown }[] }
  assertPlannedTasks(facts: readonly unknown[], parentTaskId: string): void
  coreRead(facts: readonly unknown[], domainDir: string, cutoff?: number): Promise<{ snapshot: unknown }>
  sealedDigestsOf(attachments: Pick<AttachmentStore, 'readFileStream'>, submission: Pick<RunSubmission,
    'files' | 'programDigest' | 'artifactDigest' | 'inputDigests'>): Promise<unknown>
  schedulerEvidenceOf(events: readonly unknown[], source: SchedulerMessageSource): unknown
} = await import(scriptPath)

function witness(kind: 'artifact' | 'protected' = 'artifact') {
  const digest = 'a'.repeat(64)
  const template = { id: 'count-letters', digest: 'b'.repeat(64) }
  const source = kind === 'artifact'
    ? { kind, taskId: 'extract' }
    : { kind, ref: 'source', digest }
  const bound = { name: 'in/letters.txt', digest, source: { ...source, ...(kind === 'artifact' ? { runId: 'extract-run' } : {}) } }
  const manifest = { task: 'count', taskTemplate: template, inputSources: [bound] }
  const revision = { environmentId: 'control', revisionId: 'revision', digest: digestOf(manifest) }
  const producer = { seq: 0, kind: 'run/submitted', subject: 'extract', payload: { runId: 'extract-run', submission: { artifactDigest: digest } } }
  const terminal = { seq: 1, kind: 'run/verified', subject: 'extract', payload: { runId: 'extract-run' } }
  const facts = [producer, terminal,
    { seq: 2, kind: 'task/admitted', subject: 'count', payload: { contract: { template, inputs: [{ name: bound.name, source }] } } },
    { seq: 3, kind: 'revision/created', subject: 'control', payload: { revisionId: 'revision', manifest } },
    { seq: 4, kind: 'run/started', subject: 'count', payload: { runId: 'count-run', revision } },
  ]
  const receipt = { runId: 'count-run', revision, consumption: { inputs: [{ name: bound.name, digest }] } }
  return { facts, receipt, bound, producer, terminal, manifest }
}

describe('browser evidence binds a Run to its declared input sources', () => {
  it('reads a verified producer Run and its exact artifact digest', () => {
    const h = witness()
    assert.deepEqual(inputSourcesOf(h.facts, 'count', h.receipt), [h.bound])
  })

  it('reads the protected reference and frozen digest', () => {
    const h = witness('protected')
    assert.deepEqual(inputSourcesOf(h.facts, 'count', h.receipt), [h.bound])
  })

  const changes: readonly [string, (h: ReturnType<typeof witness>) => void][] = [
    ['another producer Task', h => { Object.assign(h.bound.source, { taskId: 'stranger' }) }],
    ['another producer Run', h => { Object.assign(h.bound.source, { runId: 'another-run' }) }],
    ['unverified producer', h => { h.terminal.kind = 'run/failed' }],
    ['producer verified after consumption', h => { h.terminal.seq = 5 }],
    ['wrong artifact bytes', h => { h.producer.payload.submission.artifactDigest = 'c'.repeat(64) }],
    ['wrong consumed bytes', h => { h.receipt.consumption.inputs[0]!.digest = 'c'.repeat(64) }],
    ['another Task template', h => { h.manifest.taskTemplate = { id: 'other', digest: 'b'.repeat(64) } }],
    ['changed revision bytes', h => { Object.assign(h.manifest, { uncommitted: true }) }],
  ]
  for (const [name, change] of changes) {
    it(`rejects ${name}`, () => {
      const h = witness()
      change(h)
      if (name !== 'changed revision bytes') h.receipt.revision.digest = digestOf(h.manifest)
      assert.throws(() => inputSourcesOf(h.facts, 'count', h.receipt))
    })
  }

  it('rejects protected bytes different from the admitted digest', () => {
    const h = witness('protected')
    h.bound.digest = 'c'.repeat(64)
    h.receipt.consumption.inputs[0]!.digest = h.bound.digest
    h.receipt.revision.digest = digestOf(h.manifest)
    assert.throws(() => inputSourcesOf(h.facts, 'count', h.receipt))
  })
})

describe('actual DSH tool results', () => {
  it('retains native interrupted-turn errors without parsing them as JSON success', () => {
    const message = { toolCallId: 'call', isError: true, source: { kind: 'interrupted-turn' }, content: [{ type: 'text', text: 'Interrupted' }] }
    const facts = toolFacts([
      { seq: 1, type: 'tool/call', data: { callId: 'call', name: 'singularity_submit_program' } },
      { seq: 2, type: 'tool/result', data: { message } },
    ])
    assert.equal(facts.results[0]!.value, message)
  })
})

describe('the isolated model campaign executes the declared plan', () => {
  const plan = [
    { kind: 'task/admitted', subject: 'parent' },
    { kind: 'task/admitted', subject: 'extract' },
    { kind: 'task/admitted', subject: 'count' },
    { kind: 'task/decomposed', subject: 'parent', payload: { children: [{ taskId: 'extract' }, { taskId: 'count' }] } },
  ]
  it('accepts the parent and its declared children', () => {
    assertPlannedTasks(plan, 'parent')
  })
  it('rejects a child proposing an undeclared Task during its assigned Run', () => {
    assert.throws(() => assertPlannedTasks([...plan, { kind: 'task/admitted', subject: 'another-root' }], 'parent'))
  })
})

it('serves core snapshot reads from a fixed durable cut of a real MemoryLog', async () => {
  const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
  log.emit(admitted())
  log.emit({ ...admitted(), subject: 'later-task', commandId: 'admit-later-task' })
  const domainDir = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
  const read = await coreRead(log.entries(), domainDir, 1)
  assert.deepEqual(read.snapshot, { formatVersion: 1, controlId: 'singularity-local', cutoff: 1,
    tasks: [{ taskId: TASK_ID, goal: contract().goal, phase: 'awaiting-run', runs: [] }], plans: [] })
})

describe('browser evidence reads authoritative native file attachments', () => {
  async function sealed(check: (store: LocalAttachmentStore, submission: Pick<RunSubmission,
    'files' | 'programDigest' | 'artifactDigest' | 'inputDigests'>, home: string) => Promise<void>) {
    const home = await mkdtemp(join(tmpdir(), 'singularity-probe-sealed-'))
    const context = new Context()
    try {
      const store = new LocalAttachmentStore(context, { dshHome: home })
      const program = Buffer.from('process.stdout.write("35")')
      const artifact = Buffer.from('35')
      const input = Buffer.from('A\u0000z\xff', 'latin1')
      const files = {
        program: await store.saveFile({ name: 'program.mjs', data: program }),
        artifact: await store.saveFile({ name: 'artifact.txt', data: artifact }),
        inputs: [{ name: 'in/source.txt', attachment: await store.saveFile({ name: 'source.txt', data: input }) }],
      }
      await check(store, { files, programDigest: sha256(program), artifactDigest: sha256(artifact),
        inputDigests: [{ name: 'in/source.txt', digest: sha256(input) }] }, home)
    } finally {
      await context.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  }

  it('checks byte digests from real attachments after editable workspace bytes change', async () => {
    await sealed(async (store, submission, home) => {
      await writeFile(join(home, 'program.mjs'), 'edited program')
      assert.deepEqual(await sealedDigestsOf(store, submission), {
        programDigest: submission.programDigest, artifactDigest: submission.artifactDigest,
        inputDigests: submission.inputDigests,
      })
    })
  })

  for (const damaged of ['missing', 'corrupt', 'length', 'digest', 'input-name'] as const) {
    it(`rejects a ${damaged} sealed object or reference`, async () => {
      await sealed(async (store, submission) => {
        if (damaged === 'missing') await rm(store.fileHostPath(submission.files.artifact))
        if (damaged === 'corrupt') {
          const path = store.fileHostPath(submission.files.artifact)
          await chmod(path, 0o600)
          await writeFile(path, '00')
        }
        if (damaged === 'length') submission.files.artifact.bytes += 1
        if (damaged === 'digest') Object.assign(submission, { artifactDigest: 'a'.repeat(64) })
        if (damaged === 'input-name') Object.assign(submission.files.inputs[0]!, { name: 'in/another.txt' })
        await assert.rejects(() => sealedDigestsOf(store, submission))
      })
    })
  }
})

describe('browser evidence proves one native scheduler delivery', () => {
  function delivery(purpose: SchedulerMessageSource['purpose'] = 'dispatch') {
    const source: SchedulerMessageSource = { kind: 'singularity', purpose, controlId: 'singularity-local',
      parentTaskId: 'parent', taskId: 'child', runId: 'child-run', factSeq: 12 }
    const message = createUserMessage({ source, content: [{ type: 'text', text: 'assigned work' }] })
    const events = [
      { seq: 4, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message] } },
      { seq: 5, type: 'turn/start', data: { turn: 2 } },
      { seq: 6, type: 'user/message', data: message },
    ]
    return { source, message, events }
  }

  it.each(['dispatch', 'plan-outcome'] as const)('binds %s insertion and model entry to the same original message', purpose => {
    const h = delivery(purpose)
    assert.deepEqual(schedulerEvidenceOf(h.events, h.source), { source: h.source, messageId: h.message.id,
      insertedSeq: 4, enteredSeq: 6, turn: 2 })
  })

  it('rejects duplicate insertion of the same Run dispatch', () => {
    const h = delivery()
    assert.throws(() => schedulerEvidenceOf([...h.events, h.events[0]], h.source))
  })
  it('rejects duplicate model entry of the same outcome', () => {
    const h = delivery('plan-outcome')
    assert.throws(() => schedulerEvidenceOf([...h.events, h.events[2]], h.source))
  })
  it('rejects an inserted message that never entered the model turn', () => {
    const h = delivery()
    assert.throws(() => schedulerEvidenceOf(h.events.slice(0, 2), h.source))
  })
  it('rejects changed identity or content between inbox and user source', () => {
    const h = delivery()
    const replacement = createUserMessage({ source: h.source, content: [{ type: 'text', text: 'different work' }] })
    assert.throws(() => schedulerEvidenceOf([...h.events.slice(0, 2), { seq: 6, type: 'user/message', data: replacement }], h.source))
  })
  for (const key of ['controlId', 'parentTaskId', 'taskId', 'runId', 'factSeq'] as const) {
    it(`rejects a source that names another ${key}`, () => {
      const h = delivery()
      const expected = { ...h.source, [key]: key === 'factSeq' ? 13 : 'other' }
      assert.throws(() => schedulerEvidenceOf(h.events, expected))
    })
  }
})
