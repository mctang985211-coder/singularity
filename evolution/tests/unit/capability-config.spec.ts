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
 * - the write is atomic and can be interrupted at the seam (`before-write`), so a
 *   crash leaves the old file or the new one and the commit intent stays open.
 */
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import {
  applyCapabilityRowToConfig,
  capabilityRowRegion,
  capabilityRowText,
  renderCapabilityRow,
  writeCapabilityRowToConfig,
} from '../../src/capability-config.ts'
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
    await expect(writeCapabilityRowToConfig({ file: noEntry, name: ROW, entry: ENTRY })).rejects.toThrow(/task-runtime/)
    expect(await readFile(noEntry, 'utf8')).toBe('- id: other\n  config:\n    x: 1\n')

    const noBlock = join(dir, 'no-block.yml')
    await writeFile(noBlock, '- id: task-runtime\n  config:\n    verifyTimeoutMs: 1\n', 'utf8')
    await expect(writeCapabilityRowToConfig({ file: noBlock, name: ROW, entry: ENTRY })).rejects.toThrow(/capabilities/)

    const inline = join(dir, 'inline.yml')
    await writeFile(inline, `- id: task-runtime\n  config:\n    capabilities: { store-row: { skills: [a] } }\n---\napi:\n  key: ${FIXTURE_API_KEY}\n`, 'utf8')
    const refusal = await writeCapabilityRowToConfig({ file: inline, name: ROW, entry: ENTRY }).then(() => '', error => String(error))
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
      probe: stage => stages.push(stage),
    })
    expect(stages).toEqual(['before-write', 'written'])
    expect(written).toMatchObject({ file: path, name: ROW, direction: 'written' })
    expect(written.textDigest).toMatch(/^[0-9a-f]{64}$/)
    const after = await readFile(path, 'utf8')
    expect(rowOf(after, ROW)).toEqual(ENTRY)
    expect(after).toContain(FIXTURE_API_KEY)
    // No staging leftover beside the file: the rename consumed it.
    const entries = await readdir(join(path, '..'))
    expect(entries.filter(entry => entry.includes('.tmp-'))).toEqual([])
    // And a removal is the same write in the other direction.
    const removed = await writeCapabilityRowToConfig({ file: path, name: ROW, entry: null })
    expect(removed).toMatchObject({ direction: 'removed', rowDigest: null, textDigest: null })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('stops before writing when the seam throws, leaving the file exactly as it was', async () => {
    const path = await file()
    const before = await readFile(path, 'utf8')
    const probe = vi.fn((stage: string) => {
      if (stage === 'before-write') throw new Error('the process died here')
    })
    await expect(writeCapabilityRowToConfig({ file: path, name: ROW, entry: ENTRY, probe: probe as never })).rejects.toThrow('the process died here')
    expect(await readFile(path, 'utf8')).toBe(before)
  })
})
