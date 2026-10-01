#!/usr/bin/env node
/**
 * Backfill the durable `subagent/descriptor` fact into subagent Sessions created before
 * agent-runtime published it (`agent-runtime/src/index.ts` owns the going-forward write).
 * A child without that fact is refused by the Session Controller's history read — a client can
 * open it neither by bare id nor by its durable parent address. Run the server stopped:
 *
 *   node scripts/repair-subagent-descriptors.mjs <sessions-root> [--dry-run]
 *
 * Each store is copied beside itself (suffix `.pre-descriptor.bak`) before the appended frame.
 */
import { copyFileSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const ZSTD_MAGIC = 0xFD2FB528
const DESCRIPTOR_VERSION = 3
const PROVIDER = 'singularity-runtime'
const BACKUP_SUFFIX = '.pre-descriptor.bak'

/** Byte ranges of every structurally complete frame in a concatenated Zstandard stream. */
function zstdFrames(buffer) {
  const found = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`)
    }
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryBytes = descriptor & 0x03 === 3 ? 4 : descriptor & 0x03
    const contentSizeFlag = descriptor >>> 6
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      offset += blockType === 0x01 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    found.push({ start, end: offset })
  }
  return found
}

/** Full JSONL text of one store, across every appended frame. */
function readStore(path) {
  const buffer = readFileSync(path)
  return zstdFrames(buffer)
    .map(frame => zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
    .join('')
}

/** One checksummed frame carrying `line`, appended the way the runtime's own writer appends. */
function appendFrame(path, line) {
  const buffer = readFileSync(path)
  const frame = zstdCompressSync(Buffer.from(`${line}\n`), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
  writeFileSync(path, Buffer.concat([buffer, frame]))
}

function walkStores(root) {
  const stores = []
  for (const slug of readdirSync(root)) {
    const slugPath = join(root, slug)
    if (!statSync(slugPath).isDirectory()) continue
    for (const entry of readdirSync(slugPath)) {
      const dir = join(slugPath, entry)
      if (!statSync(dir).isDirectory()) continue
      for (const file of readdirSync(dir)) {
        if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(file)) stores.push(join(dir, file))
      }
    }
  }
  return stores
}

const root = process.argv[2]
if (root === undefined) {
  console.error('usage: repair-subagent-descriptors.mjs <sessions-root> [--dry-run]')
  process.exit(2)
}
const dryRun = process.argv.includes('--dry-run')
const repaired = []
const skipped = []

for (const store of walkStores(root)) {
  let lines
  try {
    lines = readStore(store).split('\n').filter(Boolean)
  } catch (error) {
    console.error(`unreadable ${store}: ${error.message}`)
    process.exitCode = 1
    continue
  }
  const header = JSON.parse(lines[0])
  if (header.origin !== 'subagent') continue
  if (lines.some(line => line.includes('"subagent/descriptor"'))) {
    skipped.push(header.id)
    continue
  }
  const lastSeq = lines.reduce((max, line) => Math.max(max, JSON.parse(line).seq ?? -1), -1)
  const fact = JSON.stringify({
    type: 'subagent/descriptor',
    seq: lastSeq + 1,
    time: Date.now(),
    data: { version: DESCRIPTOR_VERSION, mode: 'one-shot', provider: PROVIDER },
  })
  if (dryRun) {
    repaired.push(`${header.id} (dry run)`)
    continue
  }
  copyFileSync(store, store + BACKUP_SUFFIX)
  appendFrame(store, fact)
  repaired.push(header.id)
}

console.log(`repaired ${repaired.length}: ${repaired.join(', ') || '—'}`)
console.log(`already published ${skipped.length}: ${skipped.join(', ') || '—'}`)
