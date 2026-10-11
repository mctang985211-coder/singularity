import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'
import { digestOf } from '../../src/protocol/envelope.ts'
import { MemoryLog } from '../../src/protocol/memory-log.ts'
import { admitted, contract, SUBJECTS, TASK_ID, taskRegistry } from '../../tests/task-fixtures.ts'
const scriptPath = fileURLToPath(new URL('../../scripts/browser-probe.mjs', import.meta.url))
const { inputSourcesOf, toolFacts, assertPlannedTasks, coreRead }: {
  inputSourcesOf(facts: readonly unknown[], taskId: string, receipt: unknown): unknown
  toolFacts(events: readonly unknown[]): { results: readonly { value: unknown }[] }
  assertPlannedTasks(facts: readonly unknown[], parentTaskId: string): void
  coreRead(facts: readonly unknown[], domainDir: string, cutoff?: number): Promise<{ snapshot: unknown }>
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
