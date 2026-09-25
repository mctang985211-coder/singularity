/**
 * Where the ledger lives by default, and whether the ledger this working copy
 * has actually accumulated still folds.
 *
 * Two regressions the S4-E package move could have introduced without any test
 * failing elsewhere:
 *
 * 1. The ledger's defaults (`$DSH_HOME/evolution`, `<repoRoot>/.dsh/evolution`,
 *    `<repoRoot>/config.yml`) used to be derived from the module's own depth in
 *    the harness source tree. The service now sits in the `evolution` package,
 *    whose depth is different, so the root is an explicit config member the
 *    assembly passes — these cases pin the resolution it must keep.
 * 2. The append-only ledger keeps records written before `reportDigest`,
 *    `skillContent` and `approvalRef` existed. The copy below is read back
 *    through a real service, so a fold that only understood the newest shape
 *    would fail here instead of silently refusing a real proposal.
 */

import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvolutionService } from '../../src/index.ts'
import type { Config } from '../../src/index.ts'

/** The harness working copy this package is built inside: five levels up from this file. */
const HARNESS_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

/** The ledger this working copy accumulated (mount-time smoke runs, 2026-09-18); `/…/.dsh` is gitignored. */
const LIVE_LEDGER = join(HARNESS_ROOT, '.dsh', 'evolution', 'proposals.jsonl')

/** Byte-identical archive of {@link LIVE_LEDGER}, so the fold regression also runs where no `.dsh` exists. */
const ARCHIVED_LEDGER = fileURLToPath(new URL('./fixtures/evolution-ledger-2026-09-26.jsonl', import.meta.url))

function fixtureCtx() {
  return { reflect: { provide: () => {} }, effect: () => {} } as never
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('EvolutionService default roots', () => {
  it('resolves every default under the repoRoot the assembly passes, when DSH_HOME is unset', async () => {
    vi.stubEnv('DSH_HOME', undefined)
    const repoRoot = await mkdtemp(join(tmpdir(), 'evolution-repo-'))
    const svc = new EvolutionService(fixtureCtx(), { repoRoot })
    expect(svc.repoRoot).toBe(repoRoot)
    expect(svc.root).toBe(resolve(join(repoRoot, '.dsh', 'evolution')))
    expect(svc.skillRoot).toBe(resolve(join(repoRoot, '.dsh', 'skills')))
    expect(svc.presetRoot).toBe(resolve(join(repoRoot, '.dsh', '.agent-presets')))
    expect(svc.configFile).toBe(resolve(join(repoRoot, 'config.yml')))
    expect(svc.file).toBe(resolve(join(repoRoot, '.dsh', 'evolution', 'proposals.jsonl')))
    await rm(repoRoot, { recursive: true, force: true })
  })

  it('lets DSH_HOME govern the data roots while config.yml stays under the repoRoot', async () => {
    const home = await mkdtemp(join(tmpdir(), 'evolution-home-'))
    const repoRoot = await mkdtemp(join(tmpdir(), 'evolution-repo-'))
    vi.stubEnv('DSH_HOME', home)
    const svc = new EvolutionService(fixtureCtx(), { repoRoot })
    expect(svc.root).toBe(resolve(join(home, 'evolution')))
    expect(svc.skillRoot).toBe(resolve(join(home, 'skills')))
    expect(svc.presetRoot).toBe(resolve(join(home, '.agent-presets')))
    expect(svc.configFile).toBe(resolve(join(repoRoot, 'config.yml')))
    await rm(home, { recursive: true, force: true })
    await rm(repoRoot, { recursive: true, force: true })
  })

  it('keeps an explicit config member over every default', async () => {
    vi.stubEnv('DSH_HOME', undefined)
    const config: Config = {
      repoRoot: join(HARNESS_ROOT, 'not-the-real-root'),
      root: '/tmp/ledger',
      skillRoot: '/tmp/skills',
      presetRoot: '/tmp/presets',
      configFile: '/tmp/config.yml',
    }
    const svc = new EvolutionService(fixtureCtx(), config)
    expect([svc.root, svc.skillRoot, svc.presetRoot, svc.configFile])
      .toEqual(['/tmp/ledger', '/tmp/skills', '/tmp/presets', '/tmp/config.yml'])
  })
})

describe('EvolutionService against the accumulated ledger', () => {
  it('loads and lists the working copy\'s old-format ledger without rewriting or refusing a record', async () => {
    // The live ledger when this working copy has one, else its archived copy —
    // same bytes either way, so the fold regression is not skipped where `/…/.dsh` is absent.
    const source = await readFile(LIVE_LEDGER, 'utf8').then(
      text => ({ path: LIVE_LEDGER, text }),
      () => readFile(ARCHIVED_LEDGER, 'utf8').then(text => ({ path: ARCHIVED_LEDGER, text })),
    )
    const root = await mkdtemp(join(tmpdir(), 'evolution-old-ledger-'))
    const file = join(root, 'proposals.jsonl')
    await copyFile(source.path, file)
    const svc = new EvolutionService(fixtureCtx(), { root })
    const proposals = await svc.list()

    // Newest first, and every id the ledger never rewrote is still there.
    expect(proposals.map(item => item.proposalId)).toEqual(
      expect.arrayContaining(['m3-prop-skill', 'm3-prop-cap', 'm2-prop-manual', 'm2-prop-diag']),
    )
    expect((await svc.get('m2-prop-manual')).targetType).toBe('workflow_policy')
    expect((await svc.get('m2-prop-manual')).status).toBe('proposed')

    // Pre-`reportDigest` replay evidence still folds, and the applied/rolledback
    // pair it produced is still readable with its approval refs.
    const rolledBack = await svc.get('m3-prop-skill')
    expect(rolledBack.status).toBe('rolledback')
    expect(rolledBack.replayed).toEqual({
      report: 'sandbox/m3-prop-skill/replay-report.json',
      verdict: 'not-worse',
      tasks: [{ taskId: 't-e504bab7-d56c-44a6-a7fc-76348d002935', relation: 'not-worse', holdout: false }],
    })
    expect(rolledBack.replayed!.reportDigest).toBeUndefined()
    expect(rolledBack.applied!.approvalRef).toMatch(/^approval:/)
    expect(rolledBack.rolledback!.approvalRef).toMatch(/^approval:/)

    // A skill candidate prepared before content binding carries no identity, and
    // a decided record written before the approval ref existed carries none.
    expect(rolledBack.prepared!.skillContent).toBeUndefined()
    expect((await svc.get('m2-prop-diag')).decisionApprovalRef).toBeUndefined()

    // Reading never rewrote the file: byte for byte what was copied in.
    expect(await readFile(file, 'utf8')).toBe(source.text)
    await rm(root, { recursive: true, force: true })
  })
})
