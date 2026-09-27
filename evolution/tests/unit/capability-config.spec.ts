/**
 * A6: the capability table's own text — the file a restart loads its registry
 * from, and the one thing an apply has to write for an applied row to survive
 * the process that applied it.
 *
 * What these cases pin:
 *
 * - the edit touches **one region** (the row of one name inside the
 *   `capabilities:` block of the `- id: task-runtime` entry in the first
 *   document): every other byte — comments, key order, the `api:` document where
 *   a deployment keeps its key — is preserved, and the row reads back as the row
 *   that was written;
 * - a row the file does not hold is *added*, a row it holds is replaced, and a
 *   null entry *removes* it — one path for apply and rollback;
 * - a file this writer cannot edit faithfully is refused by name with nothing
 *   written (no task-runtime entry, no capabilities block, an inline block);
 * - the composed identity a prepare freezes — the whole file it read, and the
 *   whole files its own two directions leave — is what the write's comparison is
 *   made against: a table that is neither the state the write starts from nor the
 *   state its own write left (a third party's edit, or an edit made while the
 *   write was being prepared) is `capability-table-changed` with nothing written,
 *   and a retry that finds its own result still settles;
 * - the write is atomic and can be interrupted at the seam (`before-write`), so a
 *   crash leaves the old file or the new one and the commit intent stays open.
 */
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import {
  applyCapabilityRowToConfig,
  capabilityRowRegion,
  capabilityRowText,
  capabilityTableIdentity,
  renderCapabilityRow,
  writeCapabilityRowToConfig,
} from '../../src/capability-config.ts'
import type { CapabilityTableStates } from '../../src/capability-config.ts'
import { sha256Hex } from '../../src/commit.ts'
import { FIXTURE_API_KEY, writeCapabilityConfig } from '../../../tests/support/capability-config.ts'

const ROW = 'a6-experiment-row'
const ENTRY: CapabilityConfig = { skills: ['the-new-skill'], tools: ['filesystem'] }

async function file(rows: Record<string, CapabilityConfig> = { 'store-row': { skills: ['store-skill'] } }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'capability-config-'))
  return await writeCapabilityConfig(join(dir, 'config.yml'), rows)
}

/** The row this writer left, parsed back from the line it rendered. */
function rowOf(text: string, name: string): unknown {
  const region = capabilityRowText(text, 'config.yml', name)!
  return JSON.parse(region.slice(region.indexOf(': ') + 2)) as unknown
}

/** One row's own line, as the file spells it — for the rows the fixture wrote in its own style. */
function lineOf(text: string, name: string): string {
  return text.split('\n').find(line => line.trimStart().startsWith(`${name}:`))!
}

/** SHA-256 of one text's exact bytes — the whole-file digest basis every table comparison uses. */
function textDigest(text: string): string {
  return sha256Hex(Buffer.from(text, 'utf8'))
}

/** The two whole-file states a write of `entry` into `text` may find: `text` as read, and the text its own write leaves. */
function statesFor(text: string, path: string, name: string, entry: CapabilityConfig | null): CapabilityTableStates {
  return { beforeSha256: textDigest(text), afterSha256: textDigest(applyCapabilityRowToConfig({ text, file: path, name, entry })) }
}

/**
 * A state pair no real file can equal, for the cases that never reach the
 * comparison: a file this writer cannot edit faithfully is refused while the row
 * region is located, before any whole-file digest is looked at.
 */
const NEVER: CapabilityTableStates = { beforeSha256: '0'.repeat(64), afterSha256: '1'.repeat(64) }

describe('the capability table text', () => {
  it('replaces one row, leaves every other byte alone, and reads the row back', async () => {
    const path = await file()
    const before = await readFile(path, 'utf8')
    const region = capabilityRowRegion(before, path, 'store-row')!
    expect(region.name).toBe('store-row')
    const next = applyCapabilityRowToConfig({ text: before, file: path, name: ROW, entry: ENTRY })
    expect(next).not.toBe(before)
    expect(rowOf(next, ROW)).toEqual(ENTRY)
    // The row that was already there is untouched, and so is everything else:
    // the block, the other entries and the whole second document (the key with
    // it) are the bytes they were.
    expect(lineOf(next, 'store-row')).toBe(lineOf(before, 'store-row'))
    expect(next).toContain(FIXTURE_API_KEY)
    const stripped = (text: string): string => text.split('\n').filter(line => !line.includes(ROW)).join('\n')
    expect(stripped(next)).toBe(stripped(before))
    expect(capabilityRowRegion(next, path, ROW)!.indent).toBe(region.indent)
  })

  it('replaces a row the deployment wrote by hand, and removes a row with a null entry', async () => {
    const path = await file({ 'hand-written': { skills: ['a'], tools: ['filesystem'] } })
    const text = await readFile(path, 'utf8')
    const replaced = applyCapabilityRowToConfig({ text, file: path, name: 'hand-written', entry: ENTRY })
    expect(rowOf(replaced, 'hand-written')).toEqual(ENTRY)
    // A rollback of a row the commit added removes it: the region is gone and
    // nothing around it moved.
    const removed = applyCapabilityRowToConfig({ text: replaced, file: path, name: 'hand-written', entry: null })
    expect(capabilityRowText(removed, path, 'hand-written')).toBeNull()
    expect(removed).not.toContain('hand-written')
    expect(removed).toContain(FIXTURE_API_KEY)
    expect(lineOf(removed, 'store-row')).toBe(lineOf(text, 'store-row'))
  })

  it('adds a row the table does not hold, at the block\'s own indentation', async () => {
    const path = await file({ first: { skills: ['a'] }, second: { skills: ['b'] } })
    const text = await readFile(path, 'utf8')
    const next = applyCapabilityRowToConfig({ text, file: path, name: ROW, entry: ENTRY })
    expect(rowOf(next, ROW)).toEqual(ENTRY)
    const rendered = capabilityRowText(next, path, ROW)!
    expect(rendered).toBe(renderCapabilityRow(ROW, ENTRY, capabilityRowRegion(text, path, 'first')!.indent))
    expect(lineOf(next, 'first')).toBe(lineOf(text, 'first'))
    expect(lineOf(next, 'second')).toBe(lineOf(text, 'second'))
    expect(next.indexOf(rendered)).toBeGreaterThan(next.indexOf('second:'))
  })

  it('refuses a file it cannot edit faithfully, naming the path and never quoting the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'capability-config-'))
    const noEntry = join(dir, 'no-entry.yml')
    await writeFile(noEntry, '- id: other\n  config:\n    x: 1\n', 'utf8')
    await expect(writeCapabilityRowToConfig({ file: noEntry, name: ROW, entry: ENTRY, states: NEVER })).rejects.toThrow(/task-runtime/)
    expect(await readFile(noEntry, 'utf8')).toBe('- id: other\n  config:\n    x: 1\n')

    const noBlock = join(dir, 'no-block.yml')
    await writeFile(noBlock, '- id: task-runtime\n  config:\n    verifyTimeoutMs: 1\n', 'utf8')
    await expect(writeCapabilityRowToConfig({ file: noBlock, name: ROW, entry: ENTRY, states: NEVER })).rejects.toThrow(/capabilities/)

    const inline = join(dir, 'inline.yml')
    await writeFile(inline, `- id: task-runtime\n  config:\n    capabilities: { store-row: { skills: [a] } }\n---\napi:\n  key: ${FIXTURE_API_KEY}\n`, 'utf8')
    const refusal = await writeCapabilityRowToConfig({ file: inline, name: ROW, entry: ENTRY, states: NEVER }).then(() => '', error => String(error))
    expect(refusal).toContain('inline')
    // The deployment's secrets are never quoted back: a refusal names the file
    // and the row, and nothing else in it.
    expect(refusal).not.toContain(FIXTURE_API_KEY)
  })

  it('writes atomically: the row lands, the staging file is gone, and the probe sees both stages', async () => {
    const path = await file()
    const before = await readFile(path, 'utf8')
    const stages: string[] = []
    const written = await writeCapabilityRowToConfig({
      file: path,
      name: ROW,
      entry: ENTRY,
      states: statesFor(before, path, ROW, ENTRY),
      probe: stage => stages.push(stage),
    })
    expect(stages).toEqual(['before-write', 'staged', 'written'])
    expect(written).toMatchObject({ file: path, name: ROW, direction: 'written' })
    expect(written.textDigest).toMatch(/^[0-9a-f]{64}$/)
    const after = await readFile(path, 'utf8')
    expect(rowOf(after, ROW)).toEqual(ENTRY)
    expect(after).toContain(FIXTURE_API_KEY)
    // No staging leftover beside the file: the rename consumed it.
    const entries = await readdir(join(path, '..'))
    expect(entries.filter(entry => entry.includes('.tmp-'))).toEqual([])
    // And a removal is the same write in the other direction.
    const removed = await writeCapabilityRowToConfig({
      file: path,
      name: ROW,
      entry: null,
      states: statesFor(after, path, ROW, null),
    })
    expect(removed).toMatchObject({ direction: 'removed', rowDigest: null, textDigest: null })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('stops before writing when the seam throws, leaving the file exactly as it was', async () => {
    const path = await file()
    const before = await readFile(path, 'utf8')
    const probe = vi.fn((stage: string) => {
      if (stage === 'before-write') throw new Error('the process died here')
    })
    await expect(
      writeCapabilityRowToConfig({ file: path, name: ROW, entry: ENTRY, states: statesFor(before, path, ROW, ENTRY), probe: probe as never }),
    ).rejects.toThrow('the process died here')
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('verifies the file one last time at the staged seam, immediately before the rename', async () => {
    // POSIX rename is an unconditional replace, so the only deterministic way to
    // show the window is closed is to land the third party's write at the last
    // seam the commit's own code runs — the point the staged bytes are durable
    // beside the target and the rename has not happened yet (EVO-2 P2).
    const path = await file()
    const text = await readFile(path, 'utf8')
    const states = statesFor(text, path, ROW, ENTRY)
    const thirdParty = text.replace('skills: [store-skill] }', 'skills: [store-skill], tools: [bash] }')
    expect(thirdParty).not.toBe(text)
    const stages: string[] = []
    const refusal = await writeCapabilityRowToConfig({
      file: path,
      name: ROW,
      entry: ENTRY,
      states,
      probe: stage => {
        stages.push(stage)
        if (stage === 'staged') writeFileSync(path, thirdParty, 'utf8')
      },
    }).then(() => '', error => String(error))

    expect(refusal).toContain('capability-table-changed')
    expect(refusal).toContain(ROW)
    // The verification ran after the seam: the staged bytes were removed with
    // the write, and the file keeps exactly what the third party wrote.
    expect(stages).toEqual(['before-write', 'staged'])
    expect(await readFile(path, 'utf8')).toBe(thirdParty)
    expect((await readdir(join(path, '..'))).filter(entry => entry.includes('.tmp-'))).toEqual([])
  })

  it('accepts a file that reads as this write\'s own result at the staged seam (a retry still settles)', async () => {
    // The other side of the same check: a file that already holds the bytes this
    // write leaves is one of the two frozen states, so the retry renames the same
    // bytes over it and settles.
    const path = await file()
    const text = await readFile(path, 'utf8')
    const states = statesFor(text, path, ROW, ENTRY)
    const target = applyCapabilityRowToConfig({ text, file: path, name: ROW, entry: ENTRY })
    const written = await writeCapabilityRowToConfig({
      file: path,
      name: ROW,
      entry: ENTRY,
      states,
      probe: stage => {
        if (stage === 'staged') writeFileSync(path, target, 'utf8')
      },
    })
    expect(written).toMatchObject({ direction: 'written', name: ROW })
    expect(await readFile(path, 'utf8')).toBe(target)
  })
})

/**
 * The composed identity a prepare freezes (EVO-2 "内容漂移 … 零应用"): the write a
 * commit performs into the deployment's own configuration file is compared against
 * the whole file as prepare read it and the whole file this proposal's own two
 * directions leave — so a third party's edit of the row itself or of any other
 * byte is a named stop with nothing written, while a retry that finds the file
 * already holding this commit's own result still settles.
 */
describe('the capability table\'s frozen composed identity', () => {
  it('freezes the file prepare read and the two files this proposal\'s own directions leave', async () => {
    const path = await file()
    const text = await readFile(path, 'utf8')

    // The candidate adds the row: the rollback removes the very lines the apply
    // wrote, so the file it leaves is the file prepare read, byte for byte.
    const added = capabilityTableIdentity({ text, file: path, name: ROW, entry: ENTRY, restored: null })
    expect(added.baselineSha256).toBe(textDigest(text))
    expect(added.applySha256).toBe(textDigest(applyCapabilityRowToConfig({ text, file: path, name: ROW, entry: ENTRY })))
    expect(added.rollbackSha256).toBe(added.baselineSha256)

    // The candidate replaces a row the file holds: the rollback restores it in
    // this writer's own rendering, and its text is computed from the text the
    // *apply* leaves — the text the rollback really edits.
    const restored: CapabilityConfig = { skills: ['store-skill'], tools: ['bash'] }
    const replaced = capabilityTableIdentity({ text, file: path, name: 'store-row', entry: ENTRY, restored })
    const applied = applyCapabilityRowToConfig({ text, file: path, name: 'store-row', entry: ENTRY })
    expect(replaced.applySha256).toBe(textDigest(applied))
    expect(replaced.rollbackSha256).toBe(textDigest(applyCapabilityRowToConfig({ text: applied, file: path, name: 'store-row', entry: restored })))
    // The hand-written row is not the canonical rendering, so the rollback's own
    // text is not the text prepare read: the identity says so.
    expect(replaced.rollbackSha256).not.toBe(replaced.baselineSha256)
  })

  it('refuses a table that is neither the state a write starts from nor its own result, and never touches it', async () => {
    const path = await file()
    const before = await readFile(path, 'utf8')
    const refusal = await writeCapabilityRowToConfig({
      file: path,
      name: ROW,
      entry: ENTRY,
      states: { beforeSha256: 'b'.repeat(64), afterSha256: 'a'.repeat(64) },
    }).then(() => '', error => String(error))
    expect(refusal).toContain('capability-table-changed')
    expect(refusal).toContain(path)
    expect(refusal).toContain(ROW)
    // The file's own bytes are never quoted back — the deployment keeps its key
    // in it — and it is left exactly as the third party wrote it.
    expect(refusal).not.toContain(FIXTURE_API_KEY)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await readdir(join(path, '..'))).filter(entry => entry.includes('.tmp-'))).toEqual([])
  })

  it('accepts the file its own write already left: a retry writes the same bytes and settles', async () => {
    const path = await file()
    const text = await readFile(path, 'utf8')
    const states = statesFor(text, path, ROW, ENTRY)
    const first = await writeCapabilityRowToConfig({ file: path, name: ROW, entry: ENTRY, states })
    const written = await readFile(path, 'utf8')
    expect(textDigest(written)).toBe(states.afterSha256)
    const retry = await writeCapabilityRowToConfig({ file: path, name: ROW, entry: ENTRY, states })
    expect(retry).toEqual(first)
    expect(await readFile(path, 'utf8')).toBe(written)
  })

  it('refuses a table a third party rewrote while the write was prepared (the before-write seam)', async () => {
    const path = await file()
    const text = await readFile(path, 'utf8')
    const states = statesFor(text, path, ROW, ENTRY)
    const thirdParty = text.replace('skills: [store-skill] }', 'skills: [store-skill], tools: [bash] }')
    expect(thirdParty).not.toBe(text)
    let rewritten = false
    const refusal = await writeCapabilityRowToConfig({
      file: path,
      name: ROW,
      entry: ENTRY,
      states,
      probe: stage => {
        if (stage !== 'before-write' || rewritten) return
        rewritten = true
        writeFileSync(path, thirdParty, 'utf8')
      },
    }).then(() => '', error => String(error))
    expect(refusal).toContain('capability-table-changed')
    // The window between the read the edit was computed from and the write is
    // closed: the write the third party landed there is what the file keeps.
    expect(await readFile(path, 'utf8')).toBe(thirdParty)
  })
})
