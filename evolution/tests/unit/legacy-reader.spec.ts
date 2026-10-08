/**
 * The legacy projection: a formatVersion ≤ 4 ledger is read for display and for
 * nothing else. Zero writes, no adoption, no progress — and a v5 line is refused
 * by name rather than folded into a shape that would pretend to be history.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { legacyStatusOf, readLegacyMethods, readLegacyMethodsSync } from '../../src/history/legacy-reader.ts'

const AT = '2026-10-08T00:00:00.000Z'
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function ledgerFile(lines: readonly unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'legacy-reader-'))
  dirs.push(dir)
  const file = join(dir, 'proposals.jsonl')
  await writeFile(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  return file
}

const proposed = {
  formatVersion: 4,
  kind: 'proposed',
  proposalId: 'p1',
  targetType: 'skill',
  targetId: 'task-coordination',
  baseVersion: 'v1',
  level: 'L2',
  rationale: 'the failure points at the guidance',
  sourceRefs: ['diagnosis:d1'],
  actor: 'supervisor',
  at: AT,
}

describe('reading a legacy ledger', () => {
  it('projects the seven legacy states in ledger order', () => {
    const views = readLegacyMethodsSync(
      [
        proposed,
        { formatVersion: 4, kind: 'candidate', proposalId: 'p1', versionSet: { skill: 'v2' }, mutation: {}, actor: 'supervisor', at: AT },
        { formatVersion: 4, kind: 'prepared', proposalId: 'p1', sandbox: 'sandbox/p1', mechanical: true, champion: 'captured', files: [], actor: 'supervisor', at: AT },
        { formatVersion: 4, kind: 'gated', proposalId: 'p1', gate: { targetFailureFixed: 'yes' }, actor: 'supervisor', at: AT },
        { formatVersion: 4, kind: 'decided', proposalId: 'p1', decision: 'PROMOTE', approvalRef: 'approval:1', actor: 'supervisor', at: AT },
      ].map(line => JSON.stringify(line)).join('\n'),
    )
    expect(views).toHaveLength(1)
    const view = views[0]!
    expect(legacyStatusOf(view)).toBe('decided')
    expect(view.decision).toBe('PROMOTE')
    expect(view.history.map(entry => entry.status)).toEqual(['proposed', 'candidate', 'prepared', 'gated', 'decided'])
  })

  it('shows an open commit intent, its files and the completion that closed it', () => {
    const withIntent = readLegacyMethodsSync(
      [
        proposed,
        {
          formatVersion: 4,
          kind: 'commit_intent',
          intentId: 'p1/apply',
          proposalId: 'p1',
          direction: 'apply',
          approvalRef: 'approval:1',
          files: [{ target: '/prod/skills/task-coordination/SKILL.md' }],
          actor: 'supervisor',
          at: AT,
        },
      ].map(line => JSON.stringify(line)).join('\n'),
    )[0]!
    expect(withIntent.intent).toMatchObject({ intentId: 'p1/apply', direction: 'apply' })
    expect(withIntent.intent?.files).toEqual(['/prod/skills/task-coordination/SKILL.md'])

    const applied = readLegacyMethodsSync(
      [proposed, { formatVersion: 4, kind: 'applied', proposalId: 'p1', targets: ['/prod/x'], approvalRef: 'approval:1', intentId: 'p1/apply', actor: 'supervisor', at: AT }]
        .map(line => JSON.stringify(line))
        .join('\n'),
    )[0]!
    expect(applied.status).toBe('applied')
    expect(applied.appliedTargets).toEqual(['/prod/x'])
    expect(applied.intent).toBeUndefined()
  })

  it('records the experiments the ledger started, and filters by library', () => {
    const views = readLegacyMethodsSync(
      [
        proposed,
        { formatVersion: 4, kind: 'experiment_started', proposalId: 'p1', experimentId: 'exp-1', frozen: { libraryId: 'other' }, actor: 'supervisor', at: AT },
      ].map(line => JSON.stringify(line)).join('\n'),
    )
    expect(views[0]!.experiments).toEqual(['exp-1'])
    expect(readLegacyMethodsSync(`${JSON.stringify(proposed)}\n`, { libraryId: 'other' })).toHaveLength(1)
  })

  it('refuses a v5 line by name', () => {
    expect(() =>
      readLegacyMethodsSync(JSON.stringify({ formatVersion: 5, kind: 'draft', draftId: 'd0001' })),
    ).toThrow(/v5 record/)
  })

  it('reads a file that does not exist as no history, and writes nothing when it does', async () => {
    expect(await readLegacyMethods('/nonexistent/proposals.jsonl')).toEqual([])
    const file = await ledgerFile([proposed])
    const before = await readFile(file)
    const views = await readLegacyMethods(file)
    expect(views).toHaveLength(1)
    expect(await readFile(file)).toEqual(before)
  })
})
