/**
 * Where the ledger lives by default, and what the service does with the v1
 * ledger this working copy has accumulated.
 *
 * Two regressions the S4-E package move could have introduced without any test
 * failing elsewhere:
 *
 * 1. The ledger's defaults (`$DSH_HOME/evolution`, `<repoRoot>/.dsh/evolution`,
 *    `<repoRoot>/config.yml`) used to be derived from the module's own depth in
 *    the harness source tree. The service now sits in the `evolution` package,
 *    whose depth is different, so the root is an explicit config member the
 *    assembly passes — these cases pin the resolution it must keep.
 * 2. The ledger is `formatVersion: 2` and nothing else (S4-E 收尾). The v1
 *    ledger archived below is refused at load by name, with the line and the
 *    version it saw, and the refusal appends nothing — the v1 reader is gone
 *    with the v1 format, and the operator's step is the persistence contract's:
 *    archive the old bytes and start a new ledger.
 */

import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvolutionService } from '../../src/index.ts'
import type { Config } from '../../src/index.ts'

/** The harness working copy this package is built inside: five levels up from this file. */
const HARNESS_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

/** Byte-identical archive of the v1 ledger this working copy accumulated (mount-time smoke runs, 2026-09-18). */
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

describe('EvolutionService against the accumulated v1 ledger', () => {
  it('refuses the v1 ledger by name — line and version — and appends nothing either way', async () => {
    const text = await readFile(ARCHIVED_LEDGER, 'utf8')
    const root = await mkdtemp(join(tmpdir(), 'evolution-old-ledger-'))
    const file = join(root, 'proposals.jsonl')
    await copyFile(ARCHIVED_LEDGER, file)
    const svc = new EvolutionService(fixtureCtx(), { root })

    // The refusal names the first line and the version it saw; the v1 records
    // (including its two `replayed` lines) are never folded.
    await expect(svc.list()).rejects.toThrow(/line 1 in .*proposals\.jsonl declares formatVersion 1/)
    await expect(svc.get('m3-prop-skill')).rejects.toThrow(/formatVersion 1/)

    // A write appends nothing either: the loaded ledger rejects before the
    // write queue is ever reached, so the v1 bytes stay exactly as archived.
    await expect(svc.propose({
      proposalId: 'new-1',
      targetType: 'skill',
      targetId: 'verify',
      baseVersion: 'v1',
      level: 'L2',
      rationale: 'must not land',
      sourceRefs: ['diagnosis:d1'],
    }, 'root-1')).rejects.toThrow(/formatVersion 1/)
    expect(await readFile(file, 'utf8')).toBe(text)

    // Nothing beside the ledger was created either — no sandbox, no archive.
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
    expect(existsSync(join(root, 'new-1'))).toBe(false)
    await rm(root, { recursive: true, force: true })
  })
})
