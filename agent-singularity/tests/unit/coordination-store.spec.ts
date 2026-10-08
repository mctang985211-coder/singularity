/**
 * The coordination store: two row kinds, one file, an append that is on the
 * device before it returns, and a refusal for anything the current protocol does
 * not read. The serial region and the binding read are what make "claim before
 * spawn" and "the completion tools resolve their own caller" real.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  appendAssignment,
  assignmentIsDurable,
  coordinatedWork,
  coordinationBindingSource,
  coordinationFile,
  coordinationBudget,
  onCoordinationCompletion,
  readCoordinationBinding,
  readCoordinationRows,
  recordCompletion,
  serializeCoordination,
  workOf,
  type CoordinationAssignment,
} from '../../src/coordination/store.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coord-store-'))
  vi.stubEnv('SINGULARITY_COORDINATION_DIR', dir)
  vi.stubEnv('SINGULARITY_COORDINATION_BUDGET', '')
  vi.stubEnv('DSH_HOME', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function assignment(overrides: Partial<CoordinationAssignment> = {}): CoordinationAssignment {
  return {
    formatVersion: 1,
    kind: 'assignment',
    graphId: 'g1',
    storeId: 'sg-t-root',
    epoch: 1,
    role: 'supervisor',
    subject: {
      kind: 'round',
      businessRound: 1,
      searchRound: 1,
      source: { taskId: 't-root', runId: 'r-1' },
    },
    sessionId: 's-sup-1',
    actor: 's-root',
    digest: 'digest-1',
    at: '2026-10-08T00:00:00.000Z',
    ...overrides,
  }
}

describe('the coordination file', () => {
  test('an unwritten file is a state, not an error, and its path comes from the env', async () => {
    expect(coordinationFile()).toBe(join(dir, 'assignments.jsonl'))
    expect(await readCoordinationRows()).toBeUndefined()
  })

  test('an assignment is readable from a fresh read of the file the moment the append returns', async () => {
    await appendAssignment(assignment())
    // No cache, no flush call: the bytes are on the file the append returned from.
    const text = readFileSync(coordinationFile(), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text.trim())).toMatchObject({ kind: 'assignment', sessionId: 's-sup-1' })
    expect(await readCoordinationRows()).toHaveLength(1)
    expect(await assignmentIsDurable('s-sup-1')).toBe(true)
    expect(await assignmentIsDurable('s-other')).toBe(false)
  })

  test('a row of another format version or kind is refused by name', async () => {
    await appendAssignment(assignment())
    await appendFile(coordinationFile(), `${JSON.stringify({ formatVersion: 2, kind: 'claim' })}\n`, 'utf8')
    await expect(readCoordinationRows()).rejects.toThrow(/unrecognized row 2/)
  })

  test('a corrupt line is refused rather than silently skipped', async () => {
    writeFileSync(coordinationFile(), '{not json\n', 'utf8')
    await expect(readCoordinationRows()).rejects.toThrow(/corrupt line 1/)
  })
})

describe('the completion record', () => {
  test('one completion per session is what the work item shows, and listeners hear the write', async () => {
    await appendAssignment(assignment())
    const heard: string[] = []
    const dispose = onCoordinationCompletion(completion => heard.push(completion.sessionId))
    await recordCompletion({
      formatVersion: 1,
      kind: 'completion',
      graphId: 'g1',
      storeId: 'sg-t-root',
      epoch: 1,
      role: 'supervisor',
      sessionId: 's-sup-1',
      result: {
        kind: 'completed',
        businessAction: 'finish',
        reason: 'nothing left to improve',
        evidenceRefs: ['t-root#r-1'],
        trialCandidateRef: null,
        methodDecision: 'retain',
        searchNext: 'stop',
      },
      at: '2026-10-08T00:00:10.000Z',
    })
    dispose()
    expect(heard).toEqual(['s-sup-1'])
    const work = await coordinatedWork('g1')
    expect(work).toHaveLength(1)
    expect(work[0]!.completion?.result).toMatchObject({ kind: 'completed', businessAction: 'finish' })
    expect(workOf((await readCoordinationRows())!, 'g2')).toEqual([])
  })
})

describe('the binding read', () => {
  test('resolves the caller from its own row, and the source project is the seam projection', async () => {
    await appendAssignment(assignment())
    const binding = await readCoordinationBinding('s-sup-1')
    expect(binding).toMatchObject({
      graphId: 'g1',
      rootStoreId: 'sg-t-root',
      role: 'supervisor',
      sourceTaskId: 't-root',
      sourceRunId: 'r-1',
      completed: false,
    })
    const source = await coordinationBindingSource().read('s-sup-1')
    expect(source).toEqual({
      role: 'supervisor',
      sourceTaskId: 't-root',
      sourceRunId: 'r-1',
      actor: 's-root',
      rootStoreId: 'sg-t-root',
      at: '2026-10-08T00:00:00.000Z',
    })
    expect(await readCoordinationBinding('s-nothing')).toBeUndefined()
    expect(await coordinationBindingSource().read('s-nothing')).toBeUndefined()
  })

  test('two rows that disagree about one session are a conflict, never a coin toss', async () => {
    await appendAssignment(assignment())
    await appendAssignment(assignment({ storeId: 'sg-t-other', digest: 'digest-1' }))
    await expect(readCoordinationBinding('s-sup-1')).rejects.toThrow(/more than one coordination assignment/)
  })

  test('a completion marks the binding completed', async () => {
    await appendAssignment(assignment())
    await recordCompletion({
      formatVersion: 1,
      kind: 'completion',
      graphId: 'g1',
      storeId: 'sg-t-root',
      epoch: 1,
      role: 'supervisor',
      sessionId: 's-sup-1',
      result: { kind: 'interrupted', detail: 'the spawn failed' },
      at: '2026-10-08T00:00:20.000Z',
    })
    expect((await readCoordinationBinding('s-sup-1'))?.completed).toBe(true)
  })
})

describe('the serial region', () => {
  test('two queued pieces of work for one graph never interleave, and graphs do not block each other', async () => {
    const order: string[] = []
    const first = serializeCoordination('g1', async () => {
      order.push('g1-a-start')
      await new Promise(resolve => setTimeout(resolve, 20))
      order.push('g1-a-end')
    })
    const second = serializeCoordination('g1', async () => {
      order.push('g1-b')
    })
    const other = serializeCoordination('g2', async () => {
      order.push('g2')
    })
    await Promise.all([first, second, other])
    expect(order.indexOf('g1-a-end')).toBeLessThan(order.indexOf('g1-b'))
    expect(order).toContain('g2')
  })

  test('a rejection inside the region does not poison the queue', async () => {
    await expect(serializeCoordination('g1', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(serializeCoordination('g1', async () => 'after')).resolves.toBe('after')
  })
})

describe('the allowance', () => {
  test('reads the env override, then the deployment policy, then the shipped default', () => {
    expect(coordinationBudget()).toBe(8)
    vi.stubEnv('SINGULARITY_COORDINATION_BUDGET', '3')
    expect(coordinationBudget()).toBe(3)
    vi.stubEnv('SINGULARITY_COORDINATION_BUDGET', 'nonsense')
    expect(coordinationBudget()).toBe(8)
  })
})
