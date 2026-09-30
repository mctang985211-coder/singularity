import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskSnapshot } from '../../task/src/index.ts'

// This fixture executes Node directly, with only lib imports: no source aliases,
// shared in-memory graph, replacement Agent handle, or Vitest child runner.
const fixture = fileURLToPath(new URL('../support/g-graph-continuation.mjs', import.meta.url))
const workspaces: string[] = []
type Boundary = 'active' | 'question' | 'submitted' | 'missing-receipt'
type Entry = 'automatic' | 'button'
interface Report {
  pid: number
  graph: { id: string; rootSessionId: string; graphStoreId: string; layoutStoreId: string }
  storeId: string
  topology: { agents: { id: string }[] }
  snapshot: TaskSnapshot
  sessions: Record<string, { events: { type: string; data: Record<string, unknown>; seq: number; time: number }[] }>
  requests: { sessionId: string; messages: unknown[] }[]
  calls: { sessionId: string; name: string; args: unknown }[]
  selected: string[]
  automatic: { selected: string[]; requests: string[] }
  live: string[]
  config: { budget: Record<string, number>; rootBudget?: Record<string, number> }
}

afterEach(() => {
  for (const directory of workspaces.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function child(
  mode: string,
  directory: string,
  boundary: Boundary,
  entry: Entry,
  advanceMs = 0,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [fixture, mode, directory, boundary, entry], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, G_CONTINUE_CLOCK_ADVANCE_MS: String(advanceMs) },
  })
}

function transcript(result: SpawnSyncReturns<string>): string {
  return `status=${result.status} signal=${result.signal} error=${result.error}\n${result.stdout}\n${result.stderr}`
}

function readReport(directory: string, name: string): Report {
  return JSON.parse(readFileSync(join(directory, name), 'utf8')) as Report
}

function killedTree(boundary: Boundary, entry: Entry): { directory: string; before: Report } {
  const directory = mkdtempSync(join(tmpdir(), 'g-graph-continuation-'))
  workspaces.push(directory)
  const killed = child('crash', directory, boundary, entry)
  expect(killed.signal, transcript(killed)).toBe('SIGKILL')
  expect(killed.status).toBeNull()
  const before = readReport(directory, 'death.json')
  expect(before.pid).toBe(killed.pid)
  expect(before.pid).not.toBe(process.pid)
  expect(() => process.kill(before.pid, 0)).toThrow()
  expect(before.snapshot.runs).toHaveLength(4)
  expect(before.snapshot.runs.filter(run => run.executionPhase === 'waiting_children')).toHaveLength(2)
  expect(before.snapshot.runs.filter(run => run.status === 'verified')).toHaveLength(1)
  return { directory, before }
}

function leaf(report: Report) {
  const task = report.snapshot.tasks.find(item => item.objective === 'write release artifact')!
  return report.snapshot.runs.find(run => run.taskId === task.taskId)!
}

function artifact(directory: string, id: string): string {
  const paths = readdirSync(join(directory, 'sessions'), { recursive: true }).filter(path =>
    String(path).endsWith(`${id}/session.v3.jsonl`),
  )
  expect(paths).toHaveLength(1)
  return join(directory, 'sessions', String(paths[0]))
}

function assertSameCompletedTree(before: Report, after: Report, directory: string, activeNotice = true): void {
  expect(after.pid).not.toBe(before.pid)
  expect(after.graph).toEqual(before.graph)
  expect(after.storeId).toBe(before.storeId)
  expect(after.topology.agents.map(agent => agent.id)).toEqual(before.topology.agents.map(agent => agent.id))
  expect(
    after.snapshot.tasks.map(task => [task.taskId, task.runIds, task.childTaskIds, task.acceptanceCriteria]),
  ).toEqual(before.snapshot.tasks.map(task => [task.taskId, task.runIds, task.childTaskIds, task.acceptanceCriteria]))
  expect(after.snapshot.runs.map(run => [run.runId, run.taskId, run.sessionId, run.startedAt, run.batches])).toEqual(
    before.snapshot.runs.map(run => [run.runId, run.taskId, run.sessionId, run.startedAt, run.batches]),
  )
  expect(after.snapshot.runs.every(run => run.status === 'verified')).toBe(true)
  expect(after.snapshot.runs.every(run => run.verifierResults.every(result => result.status === 'pass'))).toBe(true)
  expect(new Set(after.live).size).toBe(after.live.length)
  const finished = before.snapshot.runs.find(run => run.status === 'verified')!
  expect(after.requests.filter(request => request.sessionId === finished.sessionId)).toEqual([])
  expect(after.sessions[finished.sessionId]).toEqual(before.sessions[finished.sessionId])
  // The existing durable prefix, including original tool calls and provider
  // usage, survives; new turns accumulate behind it without a reset.
  for (const run of before.snapshot.runs) {
    const events = before.sessions[run.sessionId].events
    expect(after.sessions[run.sessionId].events.slice(0, events.length)).toEqual(events)
  }
  const effects = readFileSync(join(directory, 'effects.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  expect(effects.filter(effect => effect.path === 'sibling.txt')).toHaveLength(1)
  expect(effects.filter(effect => effect.path === 'release.txt')).toHaveLength(1)
  const continued = after.sessions[leaf(after).sessionId].events.filter(
    event => event.type === 'user/message' && JSON.stringify(event.data).includes('continue this same Run'),
  )
  expect(continued).toHaveLength(activeNotice ? 1 : 0)
}

describe('G: original graph continuation through the public select entry', () => {
  it('SIGKILLs an ordinary active worker and continues the original tree after boot and concurrent select', () => {
    const { directory, before } = killedTree('active', 'automatic')
    const original = leaf(before)
    expect(original.executionPhase).toBe('active')
    expect(original.submission).toBeUndefined()
    expect(original.batches).toBeUndefined()
    expect(before.snapshot.questions?.all).toEqual([])
    const reopened = child('continue', directory, 'active', 'automatic', 3 * 60 * 60 * 1000)
    expect(reopened.status, transcript(reopened)).toBe(0)
    const after = readReport(directory, 'report.json')
    expect(after.automatic.selected).toContain(before.graph.id)
    expect(after.selected.filter(id => id === before.graph.id)).toHaveLength(4)
    expect(after.config.budget).not.toHaveProperty('wallTimeMs')
    expect(after.config.rootBudget?.wallTimeMs).toBeUndefined()
    assertSameCompletedTree(before, after, directory)
  })

  it('leaves an unselected interrupted graph idle until explicit select activates it', () => {
    const { directory, before } = killedTree('active', 'button')
    const reopened = child('continue', directory, 'active', 'button')
    expect(reopened.status, transcript(reopened)).toBe(0)
    const after = readReport(directory, 'report.json')
    expect(after.automatic.selected).not.toContain(before.graph.id)
    expect(after.automatic.requests).toEqual([])
    expect(after.selected.filter(id => id === before.graph.id)).toHaveLength(3)
    assertSameCompletedTree(before, after, directory)
  })

  it('restores the original blocking question and batch without duplicate domain effects', () => {
    const { directory, before } = killedTree('question', 'automatic')
    const question = before.snapshot.questions!.all[0]!
    expect(question.blocking).toBe(true)
    expect(question.answers).toBeUndefined()
    const reopened = child('continue', directory, 'question', 'automatic')
    expect(reopened.status, transcript(reopened)).toBe(0)
    const after = readReport(directory, 'report.json')
    expect(after.snapshot.questions!.all).toHaveLength(1)
    const restored = after.snapshot.questions!.all[0]!
    expect(restored.questionId).toBe(question.questionId)
    expect(restored.answers).toHaveLength(1)
    expect(restored.answers![0]!.resolves).toBe(true)
    assertSameCompletedTree(before, after, directory)
    for (const identity of [question.messageId, restored.answers![0]!.messageId]) {
      const splices = Object.values(after.sessions)
        .flatMap(session => session.events)
        .filter(event => event.type === 'agent/inbox/spliced' && JSON.stringify(event.data).includes(identity))
      expect(splices).toHaveLength(1)
    }
  })

  it('continues a submitted verifier under the original settlement owner without rerunning its worker', () => {
    const { directory, before } = killedTree('submitted', 'automatic')
    expect(leaf(before).executionPhase).toBe('submitted')
    expect(leaf(before).submission).toBeDefined()
    const reopened = child('continue', directory, 'submitted', 'automatic')
    expect(reopened.status, transcript(reopened)).toBe(0)
    const after = readReport(directory, 'report.json')
    expect(leaf(after).submission).toEqual(leaf(before).submission)
    expect(after.requests.filter(request => request.sessionId === leaf(before).sessionId)).toEqual([])
    assertSameCompletedTree(before, after, directory, false)
  })

  it('gives an interrupted tool receipt to the original node and allows the remaining tree to finish', () => {
    const { directory, before } = killedTree('missing-receipt', 'automatic')
    const original = leaf(before)
    const effectsBefore = readFileSync(join(directory, 'effects.jsonl'), 'utf8')
    const calls = before.sessions[original.sessionId].events.filter(event => event.type === 'tool/call')
    expect(JSON.stringify(calls)).toContain('release.txt')
    expect(before.sessions[original.sessionId].events.filter(event => event.type === 'tool/result')).toEqual([])
    const reopened = child('continue', directory, 'missing-receipt', 'automatic')
    expect(reopened.status, transcript(reopened)).toBe(0)
    const after = readReport(directory, 'report.json')
    expect(readFileSync(join(directory, 'effects.jsonl'), 'utf8')).toBe(effectsBefore)
    expect(JSON.stringify(after.requests.filter(request => request.sessionId === original.sessionId))).toContain(
      'release.txt',
    )
    expect(after.calls.filter(call => call.sessionId === original.sessionId && call.name === 'read')).toHaveLength(1)
    assertSameCompletedTree(before, after, directory)
  })

  it('reports a failed continuation wake and retries the original graph in the same process', () => {
    const { directory, before } = killedTree('active', 'button')
    const reopened = child('retry-wake', directory, 'active', 'button')
    expect(reopened.status, transcript(reopened)).toBe(0)
    const after = readReport(directory, 'report.json')
    expect((after as Report & { failure: { message: string } }).failure.message).toContain('continuation wake failed')
    assertSameCompletedTree(before, after, directory)
  })

  it('rejects unreadable Task facts, a missing Session, binding drift, and a live workspace owner without replacement identities', () => {
    const { directory, before } = killedTree('active', 'button')
    const taskLog = artifact(directory, before.storeId)
    const workerLog = artifact(directory, leaf(before).sessionId)
    const originalTask = readFileSync(taskLog, 'utf8')
    const originalWorker = readFileSync(workerLog, 'utf8')
    const ownerDirectory = join(directory, 'bindings', 'workspace-owners')
    const ownerFiles = readdirSync(ownerDirectory)
    expect(ownerFiles).toHaveLength(1)
    const ownerFile = join(ownerDirectory, ownerFiles[0]!)
    const originalOwner = readFileSync(ownerFile, 'utf8')
    const faults = [
      {
        mutate: () => {
          const lines = originalTask.trimEnd().split('\n')
          const fact = JSON.parse(lines[1]!)
          fact.data.kind = 'invalid-task-fact'
          lines[1] = JSON.stringify(fact)
          writeFileSync(taskLog, `${lines.join('\n')}\n`)
        },
        restore: () => writeFileSync(taskLog, originalTask),
        match: /task|invalid|sequence|contiguous/i,
      },
      {
        mutate: () => renameSync(dirname(workerLog), join(directory, 'missing-session')),
        restore: () => renameSync(join(directory, 'missing-session'), dirname(workerLog)),
        match: /Session|session.*(missing|does not exist)/,
      },
      {
        mutate: () => {
          const lines = originalWorker.trimEnd().split('\n')
          const header = JSON.parse(lines[0]!)
          header.parentSession = 'persisted-binding-drift'
          lines[0] = JSON.stringify(header)
          writeFileSync(workerLog, `${lines.join('\n')}\n`)
        },
        restore: () => writeFileSync(workerLog, originalWorker),
        match: /binding|parent|edge|contradict|mismatch/i,
      },
      {
        mutate: () => {
          const owner = JSON.parse(originalOwner)
          owner.pid = process.pid
          delete owner.processStartedAt
          writeFileSync(ownerFile, JSON.stringify(owner))
        },
        restore: () => writeFileSync(ownerFile, originalOwner),
        match: /workspace.*(busy|alive|owner|take over)/i,
      },
    ]
    for (const fault of faults) {
      fault.mutate()
      const faultTaskBytes = readFileSync(taskLog, 'utf8')
      const refused = child('refuse', directory, 'active', 'button')
      expect(refused.status, `${fault.match}: ${transcript(refused)}`).toBe(0)
      const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'))
      expect(report.failure.message).toMatch(fault.match)
      expect(report.requests).toEqual([])
      expect(report.topology.agents.map((agent: { id: string }) => agent.id)).toEqual(
        before.topology.agents.map(agent => agent.id),
      )
      expect(readFileSync(taskLog, 'utf8')).toBe(faultTaskBytes)
      expect(
        report.sessions.filter(
          (id: string) => id.startsWith('s-') && !before.snapshot.runs.some(run => run.sessionId === id),
        ),
      ).toEqual([])
      fault.restore()
    }
    faults[2]!.mutate()
    writeFileSync(join(directory, 'repair.json'), JSON.stringify({ path: workerLog, contents: originalWorker }))
    const retried = child('retry', directory, 'active', 'button')
    expect(retried.status, transcript(retried)).toBe(0)
    const after = readReport(directory, 'report.json')
    expect(after.selected.filter(id => id === before.graph.id)).toHaveLength(2)
    assertSameCompletedTree(before, after, directory)
  })
})
