#!/usr/bin/env node
/** Read-only export of an existing quiescent control and its reachable native evidence. */
import assert from 'node:assert/strict'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sha256 } from './experiment.mjs'

const json = value => JSON.stringify(value, null, 2) + '\n'
export async function replayControl(entries) {
  const core = await import('../src/index.ts')
  const registry = new core.ProtocolRegistry()
  for (const declare of [
    core.declareAgentProtocol,
    core.declareTaskProtocol,
    core.declareEnvironmentProtocol,
    core.declareReviewProtocol,
    core.declareMeasureProtocol,
    core.declareStrategyProtocol,
    core.declareReleaseProtocol,
  ])
    declare(registry)
  const log = core.MemoryLog.adopt(entries, registry, { subjects: {} })
  return {
    facts: log.count,
    lastDigest: entries.at(-1)?.digest ?? null,
    scope: 'frame/digest/chain/schema/fold; does not rerun external scorers or rejudge semantic findings',
  }
}
export async function exportNative({ persistence, attachments, controlId, output }) {
  assert.ok(controlId && output)
  const controlSession = `singularity:control:${controlId}`
  const sessions = new Map(),
    pendingSessions = new Set([controlSession]),
    pendingAttachments = new Map(),
    attachmentsSeen = new Set()
  const inventory = { schemaVersion: 1, controlId, cuts: [], files: [] }
  await mkdir(output, { recursive: false })
  const save = async (path, bytes, category) => {
    await mkdir(dirname(join(output, path)), { recursive: true })
    await writeFile(join(output, path), bytes, { flag: 'wx' })
    inventory.files.push({ path, sha256: sha256(bytes), category })
  }
  const discover = value => {
    if (!value || typeof value !== 'object') return
    if (typeof value.attachmentId === 'string') {
      assert.match(value.attachmentId, /^sha256:[a-f0-9]{64}$/)
      pendingAttachments.set(value.attachmentId, value)
    }
    for (const [key, held] of Object.entries(value)) {
      if (key === 'sessionId' && typeof held === 'string' && !sessions.has(held)) pendingSessions.add(held)
      else if (typeof held === 'object') discover(held)
    }
  }
  const read = async id => {
    const handle = await persistence.open(id, 'read')
    try {
      return await handle.read()
    } finally {
      await handle.close()
    }
  }
  let entries
  while (pendingSessions.size || pendingAttachments.size) {
    for (const id of pendingSessions) {
      pendingSessions.delete(id)
      if (sessions.has(id)) continue
      const data = await read(id)
      sessions.set(id, data)
      if (id === controlSession) {
        entries = data.events.filter(e => e.type === 'plugin:singularity:control').map(e => e.data.payload)
        assert.ok(entries.length > 0, 'control has no committed facts')
        await save('native/control.json', json(entries), 'control')
        await save('native/deterministic-recheck.json', json(await replayControl(entries)), 'deterministic-recheck')
        const methods = new Set()
        for (const entry of entries)
          if (entry.protocol === 'environment' && entry.payload.manifest) {
            const { digestOf } = await import('../src/protocol/envelope.ts')
            const digest = digestOf(entry.payload.manifest)
            if (!methods.has(digest)) {
              await save(`native/methods/${digest}.json`, json(entry.payload.manifest), 'methods')
              methods.add(digest)
            }
          }
        for (const [category, predicate] of [
          ['methods', e => e.protocol === 'environment'],
          ['measurement', e => e.protocol === 'measure' || e.protocol === 'strategy'],
          ['findings', e => e.protocol === 'review'],
          ['consumption', e => e.kind.includes('consum')],
          ['diffs', e => e.kind.includes('proposal') || e.kind.includes('batch')],
        ])
          await save(`native/${category}.json`, json(entries.filter(predicate)), category)
      }
      await save(
        `native/sessions/${sha256(id)}.json`,
        json(data),
        id === controlSession ? 'control-session' : 'trajectory',
      )
      inventory.cuts.push({ sessionId: id, events: data.events.length, lastSeq: data.events.at(-1)?.seq ?? null })
      discover(data)
    }
    for (const [id, ref] of pendingAttachments) {
      pendingAttachments.delete(id)
      if (attachmentsSeen.has(id)) continue
      attachmentsSeen.add(id)
      const chunks = []
      if (ref.mediaType) chunks.push(await attachments.readImage(ref))
      else for await (const chunk of attachments.readFileStream(ref)) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      assert.equal(`sha256:${sha256(bytes)}`, id, 'native attachment digest differs')
      await save(`native/attachments/${id.slice(7)}`, bytes, 'artifact')
      try {
        discover(JSON.parse(bytes.toString('utf8')))
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
    }
  }
  // Detect a concurrently advancing source; never flush or open a source for writing.
  for (const [id, before] of sessions)
    assert.equal(json(await read(id)), json(before), `source session advanced during export: ${id}`)
  await save(
    'native/context-events.json',
    json(
      [...sessions].map(([sessionId, data]) => ({
        sessionId,
        events: data.events.filter(e =>
          ['system/message', 'request/header', 'user/message', 'tool/result'].includes(e.type),
        ),
      })),
    ),
    'context',
  )
  await writeFile(join(output, 'inventory.json'), json(inventory), { flag: 'wx' })
  return inventory
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [sessionsRoot, home, controlId, compression, output] = process.argv.slice(2)
  assert.ok(
    output && ['none', 'zstd'].includes(compression),
    'Usage: evidence-export.mjs sessions-root private-home control-id none|zstd new-output-directory',
  )
  for (const source of [sessionsRoot, home]) {
    assert.ok((await lstat(resolve(source))).isDirectory(), 'existing source directory required for read-only export')
    const destination = resolve(output),
      original = resolve(source)
    assert.ok(
      destination !== original && !destination.startsWith(original + '/'),
      'export output must be outside the original home and persistence root',
    )
  }
  const { openPersistence, dshModule } = await import('./dsh-control-runtime.mjs')
  const native = await openPersistence(resolve(sessionsRoot), compression)
  try {
    const { default: Attachments } = await dshModule('@deepseek-ai/dsh-attachment-local')
    await native.context.plugin(Attachments, { dshHome: resolve(home) })
    console.log(
      json(
        await exportNative({
          persistence: native.persistence,
          attachments: native.context.attachments,
          controlId,
          output: resolve(output),
        }),
      ),
    )
  } finally {
    await native.context.fiber.dispose()
  }
}
