/**
 * The control store, against a real DSH session on disk.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import { materializeAppendBatch, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'

import {
  defineKind,
  MemoryLog,
  ProtocolRegistry,
  refuse,
  sealEnvelope,
  type Envelope,
  type ProtocolSpec,
  type RefusalCode,
} from '../src/index.ts'
import {
  CONTROL_EVENT_TYPE,
  CONTROL_PROTOCOL,
  CONTROL_VERSION,
  ControlSessionStore,
  controlSessionIdOf,
  type ControlEventData,
  type ControlStoreOptions,
} from '../src/control/session-store.ts'
import {
  SCHEDULER_ROLE,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  type TaskState,
} from '../src/task/protocol.ts'
import { asyncRefusalOf, refusalOf } from './fixtures.ts'
import { SUBJECTS, TASK_ID, contract, taskRegistry } from './task-fixtures.ts'

/** One live deployment: a JSONL root, the persistence plugin, and the cleanup that releases both. */
interface Deployment {
  readonly root: string
  readonly context: Context
  readonly persistence: SessionPersistence
}

const deployments: Deployment[] = []

afterEach(async () => {
  for (const live of deployments.splice(0)) {
    await live.context.fiber.dispose()
    await rm(live.root, { recursive: true, force: true })
  }
})

async function deployment(): Promise<Deployment> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-control-'))
  const context = new Context()
  await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const live: Deployment = { root, context, persistence: context.sessionPersistence }
  deployments.push(live)
  return live
}

function optionsFor(live: Deployment, controlId: string, registry: ProtocolRegistry = taskRegistry()): ControlStoreOptions {
  return { persistence: live.persistence, controlId, registry, subjects: SUBJECTS }
}

/** Every stored event of our own type, read from the raw JSONL artifacts: file order, then line order. */
async function storedControlEvents(root: string): Promise<Record<string, unknown>[]> {
  const files = (await readdir(root, { recursive: true })).filter(name => name.endsWith('.jsonl')).sort()
  const events: Record<string, unknown>[] = []
  for (const file of files) {
    for (const line of (await readFile(join(root, file), 'utf8')).split('\n')) {
      if (line.trim() === '') continue
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object' && (parsed as Record<string, unknown>)['type'] === CONTROL_EVENT_TYPE)
        events.push(parsed as Record<string, unknown>)
    }
  }
  return events
}

/** Plant one record whose data is deliberately malformed: the type below is a claim this spec falsifies. */
async function plantControlEvent(live: Deployment, controlId: string, data: unknown): Promise<void> {
  const handle = await live.persistence.create({
    version: SESSION_FORMAT_VERSION,
    id: controlSessionIdOf(controlId),
    createdAt: Date.now(),
    isSeeded: false,
  })
  await handle.append([{ type: CONTROL_EVENT_TYPE, seq: SessionSeq(0), time: Date.now(), data: data as ControlEventData, ignorable: true }])
  await handle.flush()
  await handle.close()
}

/** A sealed envelope no append path here would produce: what a log edited outside this store looks like. */
function plantedEnvelope(kind: string, version: number): Envelope {
  return sealEnvelope({
    protocol: TASK_PROTOCOL,
    version,
    kind,
    subject: TASK_ID,
    commandId: 'planted-command',
    emitter: SCHEDULER_ROLE,
    actor: 'runtime-1',
    at: '2026-10-09T00:00:00.000Z',
    seq: 0,
    prevDigest: null,
    payload: {},
  })
}

/** A protocol whose payload is a bare number, so a value DSH refuses can reach our frame. */
const PROBE_V1: ProtocolSpec<{ readonly numbers: readonly number[] }> = {
  initialState: { numbers: [] },
  kinds: {
    noted: defineKind<{ readonly numbers: readonly number[] }, { n: number }, {}>({
      guarantees: { appended: true },
      members: ['n'],
      nested: {},
      emitter: 'writer',
      parse: (raw, where) => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) refuse('malformed-payload', `${where} must be an object`)
        const n = (raw as Record<string, unknown>)['n']
        if (typeof n !== 'number' || !Number.isFinite(n)) refuse('malformed-payload', `${where}.n must be a finite number`)
        return { n }
      },
      reduce: (state, _envelope, payload) => ({ numbers: [...state.numbers, payload.n] }),
    }),
  },
}

function probeRegistry(): ProtocolRegistry {
  const registry = new ProtocolRegistry()
  registry.declare<{ readonly numbers: readonly number[] }>('probe', 1, PROBE_V1)
  return registry
}

describe('the control store over a real session', () => {
  it('round-trips a record through a real session file and a second store', async () => {
    const live = await deployment()
    const store = await ControlSessionStore.open(optionsFor(live, 'graph-1'))

    // The session id is derived from the supplied control id, never handed in raw.
    expect(store.sessionId).toBe(controlSessionIdOf('graph-1'))

    const admitted = await store.emit({
      commandId: 'cmd-1',
      protocol: TASK_PROTOCOL,
      version: TASK_VERSION,
      kind: TASK_KINDS.admitted,
      subject: TASK_ID,
      payload: { contract: contract() },
    })
    // The fold the successor below is compared against: it must be a real value, not two undefined
    // ones that a comparison between them would accept.
    const before = store.load()
    expect(before.stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, TASK_ID)?.contractDigest).toBeDefined()
    await store.close()

    // The stored event is ours, is marked ignorable, and its data holds exactly the four declared
    // members, carrying the sealed envelope under the first sequence of our own chain.
    const stored = await storedControlEvents(live.root)
    const carried = ((stored[0]?.['data'] ?? {}) as ControlEventData).payload
    expect([stored.length, stored[0]?.['ignorable'], Object.keys((stored[0]?.['data'] ?? {}) as ControlEventData).sort(), carried.digest, carried.seq])
      .toEqual([1, true, ['kind', 'payload', 'protocol', 'version'], admitted.digest, 0])

    // A second store over the same session adopts the same fact and folds the same state.
    const successor = await ControlSessionStore.open(optionsFor(live, 'graph-1'))
    const adopted = successor.load()
    expect([adopted.entries().map(entry => entry.digest), adopted.stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, TASK_ID)?.contractDigest])
      .toEqual([[admitted.digest], before.stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, TASK_ID)?.contractDigest])
    await successor.close()
  })

  it('keeps the medium cursor and its own chain apart when the session holds a foreign event', async () => {
    const live = await deployment()
    // Another producer used our session id for a DSH event of its own (a known) type. It is not
    // ours to interpret, but it does occupy a medium sequence number.
    const handle = await live.persistence.create({
      version: SESSION_FORMAT_VERSION,
      id: controlSessionIdOf('shared'),
      createdAt: Date.now(),
      isSeeded: false,
    })
    await handle.append([{ type: 'turn/start', seq: SessionSeq(0), time: Date.now(), data: { turn: 1 } }])
    await handle.flush()
    await handle.close()

    const store = await ControlSessionStore.open(optionsFor(live, 'shared'))
    // The foreign event is not ours to adopt: our cut holds no fact yet.
    expect(store.load().entries()).toHaveLength(0)
    const admitted = await store.emit({
      commandId: 'cmd-1',
      protocol: TASK_PROTOCOL,
      version: TASK_VERSION,
      kind: TASK_KINDS.admitted,
      subject: TASK_ID,
      payload: { contract: contract() },
    })

    // Our chain starts at 0, the medium's event sequence continues at 1, and the record is really
    // there: a store that mistook the two cursors would have returned an envelope it never wrote.
    const stored = await storedControlEvents(live.root)
    expect([admitted.seq, ...stored.map(event => event['seq'])]).toEqual([0, 1])
    await store.close()
  })

  it('refuses an unknown inner kind, version and field, each by name', async () => {
    const live = await deployment()
    const cases: readonly { readonly id: string; readonly code: RefusalCode; readonly data: ControlEventData }[] = [
      {
        id: 'unknown-kind',
        code: 'unknown-kind',
        data: { protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, kind: 'task/slammed', payload: plantedEnvelope('task/slammed', TASK_VERSION) },
      },
      {
        id: 'unknown-version',
        code: 'version-mismatch',
        data: { protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, kind: TASK_KINDS.admitted, payload: plantedEnvelope(TASK_KINDS.admitted, 7) },
      },
      {
        id: 'unknown-field',
        code: 'malformed-payload',
        data: {
          protocol: CONTROL_PROTOCOL,
          version: CONTROL_VERSION,
          kind: TASK_KINDS.admitted,
          payload: plantedEnvelope(TASK_KINDS.admitted, TASK_VERSION),
          extra: true,
        } as ControlEventData,
      },
      {
        id: 'unknown-carrier-version',
        code: 'version-mismatch',
        data: {
          protocol: CONTROL_PROTOCOL,
          version: 2,
          kind: TASK_KINDS.admitted,
          payload: plantedEnvelope(TASK_KINDS.admitted, TASK_VERSION),
        } as unknown as ControlEventData,
      },
      {
        id: 'kind-mismatch',
        code: 'malformed-payload',
        data: { protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, kind: 'run/started', payload: plantedEnvelope(TASK_KINDS.admitted, TASK_VERSION) },
      },
    ]

    for (const item of cases) {
      await plantControlEvent(live, item.id, item.data)
      const refusal = await asyncRefusalOf(() => ControlSessionStore.open(optionsFor(live, item.id)))
      expect(`${item.id}: ${refusal.code}`).toBe(`${item.id}: ${item.code}`)
    }

    // The refused open released the write lease: the next attempt refuses the same record by name
    // rather than reporting an owned session.
    expect((await asyncRefusalOf(() => ControlSessionStore.open(optionsFor(live, 'unknown-kind')))).code).toBe<RefusalCode>('unknown-kind')
  })

  it('refuses a payload whose content identity JSON could not round-trip, before anything is written', async () => {
    const live = await deployment()
    const store = await ControlSessionStore.open({
      persistence: live.persistence,
      controlId: 'unserializable',
      registry: probeRegistry(),
      subjects: { writer: 'writer-1' },
    })
    const request = { commandId: 'cmd-0', protocol: 'probe', version: 1, kind: 'noted', subject: 'probe-a', payload: { n: -0 } }

    // `-0` and `0` are distinct numbers that JSON writes identically, so this stack refuses it in
    // the content identity itself — before DSH's materializer could ever see it — and records
    // nothing for it.
    const inMemory = new MemoryLog(probeRegistry(), { subjects: { writer: 'writer-1' } })
    const inMemoryRefusal = await asyncRefusalOf(() => inMemory.emit(request))
    expect([inMemoryRefusal.code, inMemory.entries().length]).toEqual(['not-lossless-json', 0])
    // DSH refuses it one layer down, for the same reason.
    expect(() => materializeAppendBatch([{ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: -0 } }])).toThrow(TypeError)

    const storeRefusal = await asyncRefusalOf(() => store.emit(request))
    expect([storeRefusal.code, store.load().entries().length]).toEqual(['not-lossless-json', 0])

    // The refused attempt wrote no bytes and reserved no sequence: the next record is #0 and the
    // only record on disk.
    const next = await store.emit({ ...request, commandId: 'cmd-1', payload: { n: 1 } })
    expect([next.seq, (await storedControlEvents(live.root)).length]).toEqual([0, 1])
    await store.close()
  })

  it('recovers a lost reply by re-delivering the same command id, and refuses a different request under it', async () => {
    const live = await deployment()
    const store = await ControlSessionStore.open({
      persistence: live.persistence,
      controlId: 'commands',
      registry: probeRegistry(),
      subjects: { writer: 'writer-1' },
    })
    const request = { commandId: 'cmd-lost', protocol: 'probe', version: 1, kind: 'noted', subject: 'probe-a', payload: { n: 1 } }

    const committed = await store.emit(request)
    // The reply never reached the caller; re-delivering the same command must return that fact and
    // must not append a second one.
    const recovered = await store.emit(request)
    expect([recovered.digest, recovered.seq]).toEqual([committed.digest, committed.seq])
    expect(store.load().entries()).toHaveLength(1)

    // A different request under the same command id is refused, and appends nothing either.
    expect((await asyncRefusalOf(() => store.emit({ ...request, payload: { n: 2 } }))).code).toBe<RefusalCode>('command-conflict')
    expect(await storedControlEvents(live.root)).toHaveLength(1)
    await store.close()
  })

  it('refuses wiring the store cannot honour', async () => {
    const live = await deployment()

    // An empty control id would silently share one session with every other empty id.
    expect(refusalOf(() => controlSessionIdOf('')).code).toBe<RefusalCode>('malformed-declaration')

    // A role this deployment holds no trusted identity for cannot emit.
    const orphan = await ControlSessionStore.open({ ...optionsFor(live, 'no-subject'), subjects: {} })
    const request = { commandId: 'cmd-orphan', protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: TASK_KINDS.admitted, subject: TASK_ID, payload: { contract: contract() } }
    expect((await asyncRefusalOf(() => orphan.emit(request))).code).toBe<RefusalCode>('unknown-emitter-role')
    expect(await storedControlEvents(live.root)).toHaveLength(0)
    await orphan.close()

    // A closed store records nothing rather than writing after its lease is gone.
    await orphan.close()
    expect((await asyncRefusalOf(() => orphan.emit({ ...request, commandId: 'cmd-closed' }))).code).toBe<RefusalCode>('write-not-durable')
  })
})
