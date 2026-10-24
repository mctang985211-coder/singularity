import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digestOf } from '../src/protocol/envelope.ts'
import { afterEach, expect, it } from 'vitest'

const { sha256, validateRegistration, scheduleOf, validateRecords, aggregate, prepare, seal, verifyPack } =
  await import(fileURLToPath(new URL('../scripts/experiment.mjs', import.meta.url)))
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    execFileSync('chmod', ['-R', 'u+w', root])
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'experiment-artifact-'))
  roots.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  execFileSync('git', ['init', '-q', source])
  await writeFile(join(source, 'source.txt'), 'frozen source\n')
  execFileSync('git', ['add', '.'], { cwd: source })
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'],
    { cwd: source },
  )
  await writeFile(join(source, 'untracked.txt'), 'include dirty and untracked bytes\n')
  const write = async (path: string, value: unknown) => {
    const bytes = JSON.stringify(value, null, 2) + '\n'
    await writeFile(join(root, path), bytes)
    return { path, sha256: sha256(bytes) }
  }
  const assets = { workflowGuidance: '', templates: [], skills: [], tools: [] }
  const method = { ...(await write('method.json', assets)), digest: digestOf(assets) }
  const contract = await write('contract.json', {
    goal: 'Engineering artifact check',
    artifact: 'result.txt',
    inputs: [],
    criteria: [{ criterionId: 'correct', statement: 'Deliver the frozen result' }],
  })
  const reg = {
    schemaVersion: 1,
    experimentId: 'offline-integrity-fixture',
    kind: 'engineering-fixture',
    claim: 'workflow-generalization',
    model: { provider: 'fixture', model: 'no-model-call', revisionVisibility: 'unavailable', revision: null },
    costUnit: 'tokens',
    arms: [
      { id: 'h0', kind: 'frozen', method, stepBudget: 50, candidateBudget: 0 },
      { id: 'full', kind: 'workflow', method, stepBudget: 50, candidateBudget: 6 },
    ],
    tasks: [0, 1, 2].map(i => ({
      id: `task-${i}`,
      familyId: `family-${i}`,
      sourceId: `source-${i}`,
      split: 'validation',
      contract,
    })),
    trials: 2,
    order: 'alternating-forward-reverse',
    primaryMetric: 'root-accepted-and-all-hard-guards',
    missingRule: 'retain-and-withhold-inference',
    stoppingRule: 'fixed-schedule-no-optional-stop',
    analysis: {
      seed: 42,
      resamples: 1000,
      method: 'paired-family-bootstrap-95',
      minimumFamilies: 3,
      sampleSizeRationale: 'Engineering fixture; no scientific inference',
    },
    redaction: { statement: 'Synthetic offline fixture; no secrets', omitted: [] },
  }
  const evidence = await write('raw.json', { kind: 'engineering-only', result: 'accepted' })
  const records = scheduleOf(reg).map((slot: { slot: number; armId: string; taskId: string; trial: number }) => ({
    ...slot,
    rootId: `root-${slot.slot}`,
    startedAt: '2026-10-24T00:00:00Z',
    actualOrder: slot.slot,
    modelRevision: null,
    outcome: slot.armId === 'h0' ? 'failed' : 'accepted',
    hardGuards: slot.armId !== 'h0',
    reason: 'offline fixture',
    methodDigest: method.digest,
    costUnit: 'tokens',
    costs: { business: 10, search: 0, review: 2, publication: 0 },
    evidence: [evidence],
  }))
  await write('registration.json', reg)
  await write('results.json', records)
  await write('inventory.json', { schemaVersion: 1, files: [{ ...evidence, category: 'artifact' }] })
  return { root, source, reg, records, write }
}

it('freezes source including untracked files, seals evidence and reproduces a relocated pack without host/model access', async () => {
  const h = await fixture()
  const prepared = join(h.root, 'prepared'),
    pack = join(h.root, 'pack')
  const frozen = await prepare(join(h.root, 'registration.json'), prepared, h.source)
  expect(await readFile(join(prepared, 'source/tree/untracked.txt'), 'utf8')).toContain('include dirty')
  await writeFile(join(prepared, 'source/tree/added-after-freeze.txt'), 'not registered')
  await expect(
    seal(prepared, join(h.root, 'results.json'), join(h.root, 'inventory.json'), pack, frozen.freezeSha256),
  ).rejects.toThrow('source file set')
  await rm(join(prepared, 'source/tree/added-after-freeze.txt'))
  const identity = await seal(
    prepared,
    join(h.root, 'results.json'),
    join(h.root, 'inventory.json'),
    pack,
    frozen.freezeSha256,
  )
  const relocated = join(h.root, 'relocated-pack')
  await rename(pack, relocated)
  const report = await verifyPack(relocated, identity.manifestSha256)
  expect(report.comparisons[0]).toMatchObject({ independentFamilies: 3, meanDelta: 1, inference: 'engineering-only' })
  expect(report.arms[0].costs.business).toEqual({ known: 60, total: 60, unknown: 0 })
  await expect(verifyPack(relocated, '0'.repeat(64))).rejects.toThrow('manifest digest')
  await chmod(join(relocated, 'results.json'), 0o644)
  await writeFile(join(relocated, 'results.json'), '[]\n')
  await expect(verifyPack(relocated, identity.manifestSha256)).rejects.toThrow('digest differs')
})

it('rejects split leakage, digest drift, incomplete denominators, duplicate slots and false accepted guards', async () => {
  const h = await fixture()
  await validateRegistration(h.reg, h.root)
  const leaked = structuredClone(h.reg)
  leaked.tasks[1]!.familyId = leaked.tasks[0]!.familyId
  leaked.tasks[1]!.split = 'heldout'
  await expect(validateRegistration(leaked, h.root)).rejects.toThrow('split leakage')
  expect(() => validateRecords(h.reg, h.records.slice(1))).toThrow('all scheduled')
  const duplicate = structuredClone(h.records)
  duplicate[1] = duplicate[0]
  expect(() => validateRecords(h.reg, duplicate)).toThrow('duplicate result slot')
  const falsePass = structuredClone(h.records)
  falsePass[0].outcome = 'accepted'
  expect(() => validateRecords(h.reg, falsePass)).toThrow('all hard guards')
  await writeFile(join(h.root, 'contract.json'), '{}')
  await expect(validateRegistration(h.reg, h.root)).rejects.toThrow('digest differs')
})

it('retains failures and cancellation in the denominator, withholds unknown measurements/cost totals, and counts families instead of trials', async () => {
  const h = await fixture()
  const missing = structuredClone(h.records)
  missing[0].outcome = 'review-inconclusive'
  missing[0].hardGuards = null
  missing[0].costs.business = null
  const report = aggregate(h.reg, missing)
  expect(report.arms[0].splits[0].planned).toBe(6)
  expect(report.arms[0].splits[0].rootSuccessRate).toBeNull()
  expect(report.arms[0].costs.business).toEqual({ known: 50, total: null, unknown: 1 })
  expect(report.comparisons[0].interval95).toBeNull()
  expect(report.comparisons[0].independentFamilies).toBe(3)
  const cancelled = structuredClone(h.records)
  Object.assign(cancelled[0], { outcome: 'cancelled', startedAt: null, actualOrder: null, rootId: null })
  expect(aggregate(h.reg, cancelled).arms[0].splits[0].rootSuccessRate).toBe(0)
})

it('rejects symlinked preregistration inputs and refuses to overwrite a preparation directory', async () => {
  const h = await fixture()
  await rm(join(h.root, 'method.json'))
  await symlink(join(h.root, 'contract.json'), join(h.root, 'method.json'))
  await expect(validateRegistration(h.reg, h.root)).rejects.toThrow('symlink forbidden')
  await rm(join(h.root, 'method.json'))
  await h.write('method.json', { workflowGuidance: '', templates: [], skills: [], tools: [] })
  const output = join(h.root, 'prepared')
  await prepare(join(h.root, 'registration.json'), output, h.source)
  await expect(prepare(join(h.root, 'registration.json'), output, h.source)).rejects.toThrow('EEXIST')
})

it('gates research claims on their controls and independent pilot rather than relabeling offline fixtures', async () => {
  const h = await fixture()
  const stronger = { ...h.reg, claim: 'task-evidence' }
  await expect(validateRegistration(stronger, h.root)).rejects.toThrow('best-of-n')
  await expect(validateRegistration({ ...h.reg, kind: 'research' }, h.root)).rejects.toThrow(
    'evolve/validation/heldout',
  )
})

it('weights independent families equally even when a family has more cases, and retains order deviations', async () => {
  const h = await fixture()
  h.reg.tasks.push({ ...h.reg.tasks[0]!, id: 'another-case-same-family' })
  const records = scheduleOf(h.reg).map((slot: { slot: number; armId: string; taskId: string; trial: number }) => ({
    ...h.records[0],
    ...slot,
    rootId: `fresh-${slot.slot}`,
    actualOrder: slot.slot,
    outcome: slot.armId === 'full' && slot.taskId === 'task-0' ? 'accepted' : 'failed',
    hardGuards: slot.armId === 'full' && slot.taskId === 'task-0',
  }))
  const report = aggregate(h.reg, records)
  expect(report.arms[1].splits[0].rootSuccessRate).toBeCloseTo(1 / 6)
  expect(report.comparisons[0].independentFamilies).toBe(3)
  const duplicate = structuredClone(records)
  duplicate[1].rootId = duplicate[0].rootId
  expect(() => aggregate(h.reg, duplicate)).toThrow('root identity')
  records[0].actualOrder = records.length
  expect(aggregate(h.reg, records).deviations.length).toBeGreaterThan(0)
  expect(aggregate(h.reg, records).comparisons[0].interval95).toBeNull()
})

it('requires externally registered preparation identity and final-method/analysis freeze before heldout', async () => {
  const h = await fixture()
  for (const task of h.reg.tasks) task.split = 'heldout'
  await h.write('registration.json', h.reg)
  const prepared = join(h.root, 'prepared'),
    pack = join(h.root, 'pack')
  const frozen = await prepare(join(h.root, 'registration.json'), prepared, h.source)
  await expect(
    seal(prepared, join(h.root, 'results.json'), join(h.root, 'inventory.json'), pack, '0'.repeat(64)),
  ).rejects.toThrow('freeze identity')
  await expect(
    seal(prepared, join(h.root, 'results.json'), join(h.root, 'inventory.json'), pack, frozen.freezeSha256),
  ).rejects.toThrow('prior analysis/method freeze')
  const inventory = JSON.parse(await readFile(join(h.root, 'inventory.json'), 'utf8'))
  const method = h.reg.arms[0]!.method
  inventory.files.push({ ...method, category: 'methods' })
  inventory.analysisFreeze = {
    registration: sha256(await readFile(join(prepared, 'registration.json'))),
    frozenAt: '2026-10-25T00:00:00Z',
    methods: { h0: method, full: method },
  }
  await h.write('inventory.json', inventory)
  await expect(
    seal(prepared, join(h.root, 'results.json'), join(h.root, 'inventory.json'), pack, frozen.freezeSha256),
  ).rejects.toThrow('before analysis freeze')
  inventory.analysisFreeze.frozenAt = '2026-10-23T00:00:00Z'
  await h.write('inventory.json', inventory)
  const sealed = await seal(
    prepared,
    join(h.root, 'results.json'),
    join(h.root, 'inventory.json'),
    pack,
    frozen.freezeSha256,
  )
  expect((await verifyPack(pack, sealed.manifestSha256)).kind).toBe('engineering-fixture')
})
