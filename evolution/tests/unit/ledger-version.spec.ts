/**
 * The Evolution ledger's one format (S4-E 收尾): `formatVersion: 2`.
 *
 * Every line a current entry writes declares it, and a ledger declaring
 * anything else — a v1 line, a line with no version, or a mix of versions — is
 * refused at load, naming the line and the version it saw, before any new
 * record is appended. There is no dual-format reader, no online migration and
 * no fallback helper: these cases pin the refusal, and that it costs nothing on
 * disk.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProposeInput } from '../../src/index.ts'
import { EvolutionService } from '../../src/index.ts'

function fixtureCtx() {
  return { reflect: { provide: () => {} }, effect: () => {} } as never
}

const proposal: ProposeInput = {
  proposalId: 'p1',
  targetType: 'skill',
  targetId: 'verify',
  baseVersion: 'v1',
  level: 'L2',
  rationale: 'the fixture row',
  sourceRefs: ['diagnosis:d1'],
}

/** A `proposed` line as the ledger writes it, with the version under test. */
function proposedLine(formatVersion: unknown): Record<string, unknown> {
  const line = {
    formatVersion,
    kind: 'proposed',
    proposalId: 'p1',
    targetType: 'skill',
    targetId: 'verify',
    baseVersion: 'v1',
    level: 'L2',
    rationale: 'the fixture row',
    sourceRefs: ['diagnosis:d1'],
    actor: 'root-1',
    at: '2026-09-26T00:00:00.000Z',
  }
  return formatVersion === undefined ? (delete line.formatVersion, line) : line
}

async function ledgerRoot(lines: readonly Record<string, unknown>[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'evolution-version-'))
  await writeFile(join(root, 'proposals.jsonl'), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
  return root
}

describe('the ledger is formatVersion 2 and nothing else', () => {
  it('refuses a v1 line by name — line and version — before any read or write', async () => {
    const root = await ledgerRoot([proposedLine(1)])
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const svc = new EvolutionService(fixtureCtx(), { root })

    await expect(svc.list()).rejects.toThrow(/ledger line 1 in .*proposals\.jsonl declares formatVersion 1/)
    await expect(svc.get('p1')).rejects.toThrow(/formatVersion 1/)
    await expect(svc.propose({ ...proposal, proposalId: 'p2' }, 'root-1')).rejects.toThrow(/formatVersion 1/)

    // Refused before any write: the v1 bytes are exactly what was written, and
    // nothing was created beside them.
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a line with no declared version by name', async () => {
    const root = await ledgerRoot([proposedLine(undefined)])
    const svc = new EvolutionService(fixtureCtx(), { root })
    await expect(svc.list()).rejects.toThrow(/ledger line 1 in .*declares formatVersion null/)
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a mixed ledger, naming the first line of another version', async () => {
    const v2First = await ledgerRoot([proposedLine(2), proposedLine(1)])
    await expect(new EvolutionService(fixtureCtx(), { root: v2First }).list())
      .rejects.toThrow(/ledger line 2 in .*declares formatVersion 1/)

    const v1First = await ledgerRoot([proposedLine(1), proposedLine(2)])
    await expect(new EvolutionService(fixtureCtx(), { root: v1First }).list())
      .rejects.toThrow(/ledger line 1 in .*declares formatVersion 1/)

    // Neither mixed file was rewritten by the attempt.
    for (const root of [v2First, v1First]) {
      expect((await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes a fresh ledger as v2 throughout, and folds it back to the same state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-version-'))
    const svc = new EvolutionService(fixtureCtx(), { root })
    await svc.propose(proposal, 'root-1')
    await svc.candidate('p1', { skill: 'v2' }, 'root-1', { name: 'verify', content: 'candidate bytes' })

    const records = (await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { formatVersion: number; kind: string })
    expect(records.map(record => [record.kind, record.formatVersion])).toEqual([
      ['proposed', 2], ['candidate', 2],
    ])

    const reopened = new EvolutionService(fixtureCtx(), { root })
    expect(await reopened.list()).toEqual(await svc.list())
    await rm(root, { recursive: true, force: true })
  })
})
