import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { registerGraphs } from '../../graph-web/src/web/api/graphs.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** The legacy graph whose old ledger the history route projects. */
const LEGACY = {
  id: 'graph4',
  name: 'graph4',
  envId: 'project1',
  rootSessionId: 'root-legacy',
  graphStoreId: 'sg-g-root-legacy',
  layoutStoreId: 'sg-l-root-legacy',
  createdAt: 1,
  ready: true,
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'graph-evolution-read-'))
  process.env.DSH_HOME = home
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

/** The v4 ledger the pre-protocol graph wrote, in its own library. */
function seedLegacyLedger(): void {
  const library = join(home, 'singularity', 'environments', LEGACY.rootSessionId, 'evolution')
  mkdirSync(library, { recursive: true })
  const rows = [
    {
      formatVersion: 4,
      kind: 'proposed',
      proposalId: 'p',
      targetType: 'skill',
      targetId: 'method',
      baseVersion: 'absent',
      level: 'L1',
      rationale: 'Reuse the measured route',
      sourceRefs: ['diagnosis:route'],
      libraryId: LEGACY.rootSessionId,
      actor: 'root',
      at: '2026-01-01T00:00:00.000Z',
    },
    {
      formatVersion: 4,
      kind: 'decided',
      proposalId: 'p',
      decision: 'KEEP_FOR_FURTHER_RESEARCH',
      note: 'Retain the observed route for another task.',
      libraryId: LEGACY.rootSessionId,
      actor: 'root',
      at: '2026-01-01T01:00:00.000Z',
    },
  ]
  writeFileSync(join(library, 'proposals.jsonl'), rows.map(row => `${JSON.stringify(row)}\n`).join(''))
}

function harness() {
  const ctx = new Context()
  const handlers = new Map<string, Handler>()
  ctx.provide(
    'webServer',
    {
      register: ({ kind, path, handler }: { kind: string; path: string; handler: Handler }) => {
        handlers.set(`${kind}:${path}`, handler)
        return () => handlers.delete(`${kind}:${path}`)
      },
    } as never,
  )
  ctx.provide('graphs', { get: async () => LEGACY } as never)
  ctx.provide(
    'graph',
    {
      snapshotReadOnlyIn: async (id: string) => ({
        exists: true,
        snapshot: { version: 1, id, roots: ['root-legacy'], agents: [{ id: 'root-legacy', name: 'root', status: 'idle' }], edges: [] },
      }),
    } as never,
  )
  ctx.provide(
    'layout',
    { snapshotReadOnlyIn: async (id: string) => ({ exists: true, snapshot: { version: 1, id, nodes: {} } }) } as never,
  )
  ctx.provide('task', { snapshotReadOnly: async () => ({ exists: false }) } as never)
  ctx.provide('taskRuntime', { config: {} } as never)
  ctx.provide('envBuilder', { store: { get: () => ({ components: [] }) } } as never)
  registerGraphs(ctx)
  const read = async (): Promise<{ status: number; body: string }> => {
    const req = Readable.from([]) as unknown as IncomingMessage
    req.method = 'GET'
    req.url = `/singularity/graphs/${LEGACY.id}/history`
    let body = ''
    let status = 0
    const res = {
      writeHead: (code: number) => {
        status = code
      },
      end: (value: string) => {
        body = value
      },
    }
    await handlers.get('prefix:/singularity/graphs')!(req, res as unknown as ServerResponse)
    return { status, body }
  }
  return { ctx, read }
}

it('reads a sealed graph’s old ledger verbatim through the history route, and writes nothing', async () => {
  seedLegacyLedger()
  const { ctx, read } = harness()
  try {
    const { status, body } = await read()
    expect(status).toBe(200)
    const history = JSON.parse(body)
    expect(history).toMatchObject({
      formatVersion: 'legacy-v1',
      writable: false,
      access: { mode: 'legacy-readonly' },
      graph: { id: 'graph4' },
    })
    // The old proposals come back exactly as the ledger holds them: decided, with
    // its decision and note, and the history of how it got there.
    expect(history.proposals).toEqual([
      {
        proposalId: 'p',
        targetType: 'skill',
        targetId: 'method',
        baseVersion: 'absent',
        level: 'L1',
        rationale: 'Reuse the measured route',
        status: 'decided',
        decision: 'KEEP_FOR_FURTHER_RESEARCH',
        decisionNote: 'Retain the observed route for another task.',
        experiments: [],
        history: [
          { status: 'proposed', actor: 'root', at: '2026-01-01T00:00:00.000Z' },
          { status: 'decided', actor: 'root', at: '2026-01-01T01:00:00.000Z' },
        ],
      },
    ])
    // A legacy graph's task store does not exist; the history says so instead of creating one.
    expect(history.sources).toEqual([
      { id: LEGACY.graphStoreId, kind: 'topology', exists: true },
      { id: LEGACY.layoutStoreId, kind: 'layout', exists: true },
      { id: 'sg-t-root-legacy', kind: 'tasks', exists: false },
    ])
    expect(history.completions).toEqual([])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('refuses a current-protocol graph on the history route and points it at the view route', async () => {
  const ctx = new Context()
  const handlers = new Map<string, Handler>()
  ctx.provide(
    'webServer',
    {
      register: ({ kind, path, handler }: { kind: string; path: string; handler: Handler }) => {
        handlers.set(`${kind}:${path}`, handler)
        return () => handlers.delete(`${kind}:${path}`)
      },
    } as never,
  )
  ctx.provide('graphs', { get: async () => ({ ...LEGACY, protocol: { id: 'singularity/graph@2', version: 2, since: 1 } }) } as never)
  ctx.provide('graph', { snapshotReadOnlyIn: async () => ({ exists: false }) } as never)
  ctx.provide('layout', { snapshotReadOnlyIn: async () => ({ exists: false }) } as never)
  ctx.provide('task', { snapshotReadOnly: async () => ({ exists: false }) } as never)
  registerGraphs(ctx)
  try {
    const req = Readable.from([]) as unknown as IncomingMessage
    req.method = 'GET'
    req.url = `/singularity/graphs/${LEGACY.id}/history`
    let body = ''
    let status = 0
    await handlers.get('prefix:/singularity/graphs')!(req, {
      writeHead: (code: number) => {
        status = code
      },
      end: (value: string) => {
        body = value
      },
    } as unknown as ServerResponse)
    expect(status).toBe(409)
    expect(JSON.parse(body)).toEqual({
      error: 'graph-not-sealed',
      graphId: 'graph4',
      view: '/singularity/view?graphId=graph4',
    })
  } finally {
    await ctx.fiber.dispose()
  }
})
