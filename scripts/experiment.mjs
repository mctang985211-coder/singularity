#!/usr/bin/env node
/** Offline preregistration, analysis and evidence export. Never starts a model or a shell command. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { digestOf } from '../src/protocol/envelope.ts'
import { hostFindings, hostInstall } from './host-config.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => JSON.stringify(value, null, 2) + '\n'
const load = async file => JSON.parse(await readFile(file, 'utf8'))
const requireThat = (condition, detail) => assert.ok(condition, detail)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const kinds = ['frozen', 'workflow', 'best-of-n', 'skill-tool', 'raw-trajectory', 'single-agent']
const phases = ['pilot', 'evolve', 'validation', 'heldout']
const outcomes = ['accepted', 'failed', 'cancelled', 'review-inconclusive', 'infrastructure-failure']
const costKinds = ['business', 'search', 'review', 'publication']

function safeName(name) {
  requireThat(
    nonempty(name) &&
      !isAbsolute(name) &&
      !name.includes('\\') &&
      name.split('/').every(part => part && part !== '.' && part !== '..'),
    `unsafe relative path: ${name}`,
  )
  return name
}
async function regularFile(base, name) {
  safeName(name)
  let path = resolve(base)
  for (const part of name.split('/')) {
    path = join(path, part)
    requireThat(!(await lstat(path)).isSymbolicLink(), `symlink forbidden: ${name}`)
  }
  requireThat((await lstat(path)).isFile(), `not a regular file: ${name}`)
  return readFile(path)
}
async function referenced(base, ref) {
  requireThat(ref && /^[a-f0-9]{64}$/.test(ref.sha256), 'file reference needs a SHA256')
  const bytes = await regularFile(base, ref.path)
  requireThat(sha256(bytes) === ref.sha256, `digest differs: ${ref.path}`)
  return bytes
}
async function put(base, name, bytes) {
  safeName(name)
  await mkdir(dirname(join(base, name)), { recursive: true })
  await writeFile(join(base, name), bytes, { flag: 'wx' })
}
async function files(base, prefix = '') {
  const result = []
  for (const entry of await readdir(join(base, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    requireThat(!entry.isSymbolicLink(), `symlink forbidden: ${name}`)
    if (entry.isDirectory()) result.push(...(await files(base, name)))
    else {
      requireThat(entry.isFile(), `special file forbidden: ${name}`)
      result.push(name)
    }
  }
  return result.sort()
}
const unique = (values, label) => requireThat(new Set(values).size === values.length, `duplicate ${label}`)

export async function validateRegistration(reg, base) {
  requireThat(nonempty(reg.costUnit), 'explicit cost unit required')
  requireThat(reg.schemaVersion === 1 && nonempty(reg.experimentId), 'registration version/id required')
  requireThat(['engineering-fixture', 'research'].includes(reg.kind), 'research or engineering-fixture kind required')
  requireThat(
    ['workflow-generalization', 'task-evidence', 'asset-organization', 'multi-agent'].includes(reg.claim),
    'unknown claim',
  )
  requireThat(
    nonempty(reg.model?.provider) &&
      nonempty(reg.model?.model) &&
      ['visible', 'unavailable'].includes(reg.model.revisionVisibility),
    'freeze provider/model/revision visibility',
  )
  requireThat(
    reg.model.revisionVisibility === 'unavailable' ? reg.model.revision === null : nonempty(reg.model.revision),
    'revision visibility mismatch',
  )
  requireThat(Array.isArray(reg.arms) && reg.arms.length >= 2, 'at least H0 and workflow arms required')
  unique(
    reg.arms.map(a => a.id),
    'arm id',
  )
  unique(
    reg.arms.map(a => a.kind),
    'arm kind',
  )
  requireThat(
    reg.arms.some(a => a.kind === 'frozen') && reg.arms.some(a => a.kind === 'workflow'),
    'H0/workflow required',
  )
  const required = {
    'task-evidence': ['best-of-n', 'raw-trajectory'],
    'asset-organization': ['best-of-n', 'skill-tool'],
    'multi-agent': ['single-agent'],
    'workflow-generalization': [],
  }
  for (const kind of required[reg.claim])
    requireThat(
      reg.arms.some(a => a.kind === kind),
      `claim requires ${kind}`,
    )
  const methods = new Map()
  for (const arm of reg.arms) {
    requireThat(nonempty(arm.id) && kinds.includes(arm.kind), 'arm identity/kind required')
    requireThat(
      Number.isSafeInteger(arm.stepBudget) &&
        arm.stepBudget > 0 &&
        Number.isSafeInteger(arm.candidateBudget) &&
        arm.candidateBudget >= 0,
      'freeze finite arm budgets',
    )
    const method = JSON.parse((await referenced(base, arm.method)).toString('utf8'))
    requireThat(
      typeof method.workflowGuidance === 'string' &&
        ['templates', 'skills', 'tools'].every(k => Array.isArray(method[k])),
      'complete initial method required',
    )
    requireThat(arm.method.digest === digestOf(method), 'initial Method digest differs from canonical runtime identity')
    methods.set(arm.kind, method)
    if (arm.kind === 'raw-trajectory') await referenced(base, arm.informationEquivalence)
  }
  requireThat(reg.arms.find(a => a.kind === 'frozen').candidateBudget === 0, 'H0 must remain frozen')
  const full = reg.arms.find(a => a.kind === 'workflow')
  for (const arm of reg.arms.filter(a => ['best-of-n', 'raw-trajectory', 'skill-tool'].includes(a.kind))) {
    requireThat(
      arm.stepBudget === full.stepBudget && arm.candidateBudget === full.candidateBudget,
      'comparison opportunities/budgets must match',
    )
  }
  const skill = methods.get('skill-tool'),
    initial = methods.get('frozen')
  if (skill)
    requireThat(
      same(skill.templates, initial.templates) && skill.workflowGuidance === initial.workflowGuidance,
      'skill-tool arm must freeze workflow/templates',
    )
  requireThat(Array.isArray(reg.tasks) && reg.tasks.length > 0, 'tasks required; no generated substitute tasks')
  unique(
    reg.tasks.map(t => t.id),
    'task id',
  )
  const partitions = new Map()
  for (const task of reg.tasks) {
    requireThat(
      [task.id, task.familyId, task.sourceId].every(nonempty) && phases.includes(task.split),
      'freeze task/family/source/split',
    )
    for (const key of [`family:${task.familyId}`, `source:${task.sourceId}`]) {
      requireThat(!partitions.has(key) || partitions.get(key) === task.split, `split leakage: ${key}`)
      partitions.set(key, task.split)
    }
    const contract = JSON.parse((await referenced(base, task.contract)).toString('utf8'))
    requireThat(
      nonempty(contract.goal) &&
        nonempty(contract.artifact) &&
        Array.isArray(contract.inputs) &&
        Array.isArray(contract.criteria) &&
        contract.criteria.length > 0,
      'complete frozen Task contract required',
    )
    for (const ref of task.inputs ?? []) await referenced(base, ref)
    for (const input of contract.inputs)
      if (input.source?.kind === 'protected')
        requireThat(
          (task.inputs ?? []).some(ref => ref.sha256 === input.source.digest),
          'frozen protected input bytes missing from registration',
        )
  }
  requireThat(
    Number.isSafeInteger(reg.trials) && reg.trials >= 2,
    'at least two repeated trials; not independent families',
  )
  requireThat(reg.order === 'alternating-forward-reverse', 'freeze interleaving order')
  requireThat(
    reg.primaryMetric === 'root-accepted-and-all-hard-guards',
    'primary endpoint must be complete root delivery',
  )
  requireThat(
    reg.missingRule === 'retain-and-withhold-inference' && reg.stoppingRule === 'fixed-schedule-no-optional-stop',
    'freeze missingness/stopping rules',
  )
  requireThat(
    Number.isSafeInteger(reg.analysis?.seed) &&
      reg.analysis.resamples >= 1000 &&
      reg.analysis.resamples <= 100000 &&
      Number.isSafeInteger(reg.analysis.resamples) &&
      reg.analysis.method === 'paired-family-bootstrap-95',
    'freeze statistical method/seed/resamples',
  )
  requireThat(
    Number.isSafeInteger(reg.analysis.minimumFamilies) &&
      reg.analysis.minimumFamilies >= 3 &&
      nonempty(reg.analysis.sampleSizeRationale),
    'family sample-size rationale required',
  )
  if (reg.kind === 'research') {
    requireThat(
      ['evolve', 'validation', 'heldout'].every(p => reg.tasks.some(t => t.split === p)),
      'research requires family/source-separated evolve/validation/heldout',
    )
    const pilot = JSON.parse((await referenced(base, reg.analysis.independentPilot)).toString('utf8'))
    requireThat(
      pilot.kind === 'independent-pilot' &&
        nonempty(pilot.sampleSizeRationale) &&
        Number.isFinite(pilot.familyVariance) &&
        pilot.familyVariance >= 0 &&
        Array.isArray(pilot.families) &&
        pilot.families.length >= 3,
      'independent pilot variance/rationale/evidence required',
    )
    unique(
      pilot.families.map(f => f.familyId),
      'pilot family',
    )
    unique(
      pilot.families.map(f => f.sourceId),
      'pilot source',
    )
    for (const family of pilot.families)
      requireThat(
        nonempty(family.familyId) &&
          nonempty(family.sourceId) &&
          !reg.tasks.some(t => t.familyId === family.familyId || t.sourceId === family.sourceId),
        'pilot overlaps confirmatory family/source',
      )
    for (const ref of pilot.evidence ?? []) await referenced(base, ref)
    requireThat(pilot.evidence?.length > 0, 'pilot raw evidence required')
    await referenced(base, reg.environment)
  }
  requireThat(
    nonempty(reg.redaction?.statement) && Array.isArray(reg.redaction.omitted),
    'redaction statement and explicit omissions required',
  )
  return reg
}

export function scheduleOf(reg) {
  const schedule = []
  for (const split of phases)
    for (const task of reg.tasks.filter(t => t.split === split).sort((a, b) => a.id.localeCompare(b.id))) {
      for (let trial = 0; trial < reg.trials; trial++) {
        const arms = trial % 2 === 0 ? reg.arms : [...reg.arms].reverse()
        for (const arm of arms)
          schedule.push({
            slot: schedule.length,
            split,
            taskId: task.id,
            familyId: task.familyId,
            sourceId: task.sourceId,
            trial,
            armId: arm.id,
            initialMethodDigest: arm.method.digest,
            requiresAnalysisFreeze: split === 'heldout',
          })
      }
    }
  return schedule
}

async function captureSource(destination, root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const names = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  const hashes = {}
  for (const name of [...new Set(names)].sort()) {
    requireThat(
      !/(^|\/)(\.env(?:\..*)?|.*credentials.*|.*\.pem|id_rsa)$/.test(name),
      `secret-like source filename: ${name}`,
    )
    try {
      const bytes = await regularFile(root, name)
      await put(destination, `source/tree/${name}`, bytes)
      hashes[name] = sha256(bytes)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  await put(destination, 'source/dirty.patch', git(['diff', '--binary', 'HEAD', '--']))
  const state = { commit: git(['rev-parse', 'HEAD']).trim(), status: git(['status', '--porcelain=v1']), files: hashes }
  await put(destination, 'source/state.json', json(state))
  return state
}

export async function prepare(registration, output, root = ROOT) {
  const base = dirname(resolve(registration)),
    reg = await validateRegistration(await load(registration), base)
  const rel = relative(root, resolve(output))
  requireThat(nonempty(rel), 'evidence output cannot replace source checkout')
  requireThat(rel.startsWith('..') || isAbsolute(rel), 'keep formal evidence outside the source checkout')
  await mkdir(output, { recursive: false })
  const refs = [
    ...reg.arms.flatMap(a => [a.method, ...(a.informationEquivalence ? [a.informationEquivalence] : [])]),
    ...reg.tasks.flatMap(t => [t.contract, ...(t.inputs ?? [])]),
    ...[reg.analysis.independentPilot, reg.environment].filter(Boolean),
  ]
  if (reg.analysis.independentPilot)
    refs.push(...JSON.parse((await referenced(base, reg.analysis.independentPilot)).toString('utf8')).evidence)
  for (const name of [...new Set(refs.map(r => r.path))])
    await put(output, `inputs/${name}`, await regularFile(base, name))
  await put(output, 'registration.json', json(reg))
  await put(output, 'schedule.json', json(scheduleOf(reg)))
  const source = await captureSource(output, root)
  await put(
    output,
    'freeze.json',
    json({
      schemaVersion: 1,
      kind: reg.kind,
      frozenAt: new Date().toISOString(),
      registration: sha256(json(reg)),
      schedule: sha256(json(scheduleOf(reg))),
      source: sha256(json(source)),
    }),
  )
  return {
    output,
    slots: scheduleOf(reg).length,
    kind: reg.kind,
    freezeSha256: sha256(await readFile(join(output, 'freeze.json'))),
  }
}

function costsOf(records, kind) {
  const values = records.map(r => r.costs[kind])
  return {
    known: values.reduce((n, c) => n + (c ?? 0), 0),
    total: values.some(c => c === null) ? null : values.reduce((n, c) => n + c, 0),
    unknown: values.filter(c => c === null).length,
  }
}
export function validateRecords(reg, records) {
  const schedule = scheduleOf(reg)
  requireThat(
    Array.isArray(records) && records.length === schedule.length,
    'all scheduled slots, including failures/missing/cancelled, must be recorded',
  )
  unique(
    records.map(r => r.slot),
    'result slot',
  )
  unique(
    records.filter(r => r.rootId !== null).map(r => r.rootId),
    'root identity; each trial needs a fresh root',
  )
  const execution = records.filter(r => r.startedAt !== null).map(r => r.actualOrder)
  unique(execution, 'actual execution order')
  for (const row of records) {
    requireThat(Number.isSafeInteger(row.slot) && row.slot >= 0, 'integer result slot required')
    const slot = schedule[row.slot]
    requireThat(
      slot && row.armId === slot.armId && row.taskId === slot.taskId && row.trial === slot.trial,
      'result does not match frozen slot',
    )
    requireThat(outcomes.includes(row.outcome) && nonempty(row.reason), 'explicit terminal outcome/reason required')
    requireThat(
      row.startedAt === null
        ? row.actualOrder === null && row.outcome === 'cancelled'
        : Number.isFinite(Date.parse(row.startedAt)) && Number.isSafeInteger(row.actualOrder) && row.actualOrder >= 0,
      'record actual order/start or explicit unstarted cancellation',
    )
    requireThat(
      row.rootId === null ? row.startedAt === null || row.outcome === 'infrastructure-failure' : nonempty(row.rootId),
      'root identity required',
    )
    requireThat(/^[a-f0-9]{64}$/.test(row.methodDigest), 'record the actual pinned method digest')
    if (reg.arms.find(a => a.id === row.armId).kind === 'frozen')
      requireThat(row.methodDigest === slot.initialMethodDigest, 'H0 method changed')
    requireThat(
      row.modelRevision === null || nonempty(row.modelRevision),
      'explicit observed model revision or null required',
    )
    if (reg.model.revisionVisibility === 'visible' && row.startedAt !== null)
      requireThat(row.modelRevision === reg.model.revision, 'observed model revision drift')
    requireThat(typeof row.hardGuards === 'boolean' || row.hardGuards === null, 'hard-guard result required')
    if (row.outcome === 'accepted') requireThat(row.hardGuards === true, 'accepted requires all hard guards')
    requireThat(row.costUnit === reg.costUnit && nonempty(row.costUnit), 'cost unit differs from registration')
    for (const kind of costKinds)
      requireThat(
        row.costs?.[kind] === null || (Number.isFinite(row.costs?.[kind]) && row.costs[kind] >= 0),
        `missing/invalid ${kind} cost; use explicit null for unknown`,
      )
    requireThat(
      Array.isArray(row.evidence) && (row.startedAt === null || row.evidence.length > 0),
      'started trials need raw evidence references',
    )
    for (const ref of row.evidence) {
      safeName(ref.path)
      requireThat(/^[a-f0-9]{64}$/.test(ref.sha256), 'evidence digest required')
    }
  }
  const actual = records.filter(r => r.startedAt !== null).sort((a, b) => a.actualOrder - b.actualOrder)
  // Keep deviations in the evidence package; analysis withholds inference rather than discarding records.
  void actual
  return schedule
}
function interval(values, resamples, seed) {
  let state = seed >>> 0
  const random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state / 4294967296
  }
  const means = Array.from(
    { length: resamples },
    () => values.reduce(sum => sum + values[Math.floor(random() * values.length)], 0) / values.length,
  ).sort((a, b) => a - b)
  return [means[Math.floor(resamples * 0.025)], means[Math.ceil(resamples * 0.975) - 1]]
}
export function aggregate(reg, records) {
  const schedule = validateRecords(reg, records),
    bySlot = new Map(records.map(r => [r.slot, r]))
  const actual = records.filter(r => r.startedAt !== null).sort((a, b) => a.actualOrder - b.actualOrder)
  const deviations = actual.flatMap((r, i) =>
    i > 0 && r.slot < actual[i - 1].slot ? [`execution order deviated at slot ${r.slot}`] : [],
  )
  const grouped = reg.arms.map(arm => {
    const held = schedule.filter(s => s.armId === arm.id).map(s => ({ ...bySlot.get(s.slot), ...s }))
    return {
      armId: arm.id,
      costs: Object.fromEntries(costKinds.map(k => [k, costsOf(held, k)])),
      splits: phases
        .filter(p => held.some(r => r.split === p))
        .map(split => {
          const rows = held.filter(r => r.split === split)
          const family = [...new Set(rows.map(r => r.familyId))].sort().map(familyId => {
            const trials = rows.filter(r => r.familyId === familyId)
            const missing = trials.filter(r =>
              ['review-inconclusive', 'infrastructure-failure'].includes(r.outcome),
            ).length
            return {
              familyId,
              planned: trials.length,
              accepted: trials.filter(r => r.outcome === 'accepted' && r.hardGuards).length,
              missing,
              rate: missing
                ? null
                : trials.filter(r => r.outcome === 'accepted' && r.hardGuards).length / trials.length,
            }
          })
          return {
            split,
            planned: rows.length,
            outcomes: Object.fromEntries(outcomes.map(o => [o, rows.filter(r => r.outcome === o).length])),
            costs: Object.fromEntries(costKinds.map(k => [k, costsOf(rows, k)])),
            families: family,
            rootSuccessRate: family.some(f => f.rate === null)
              ? null
              : family.reduce((n, f) => n + f.rate, 0) / family.length,
          }
        }),
    }
  })
  const h0 = grouped.find(a => reg.arms.find(b => b.id === a.armId).kind === 'frozen')
  const comparisons = grouped
    .filter(a => a !== h0)
    .flatMap(arm =>
      arm.splits.map(split => {
        const base = h0.splits.find(s => s.split === split.split)
        const deltas = split.families.map(f => {
          const a = base.families.find(b => b.familyId === f.familyId)
          return f.rate === null || a.rate === null ? null : f.rate - a.rate
        })
        const complete = deltas.every(d => d !== null),
          enough = deltas.length >= reg.analysis.minimumFamilies
        return {
          armId: arm.armId,
          baseline: h0.armId,
          split: split.split,
          independentFamilies: deltas.length,
          meanDelta: complete ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null,
          interval95:
            complete && enough && deviations.length === 0
              ? interval(deltas, reg.analysis.resamples, reg.analysis.seed)
              : null,
          inference:
            reg.kind === 'engineering-fixture'
              ? 'engineering-only'
              : deviations.length
                ? 'withheld-protocol-deviation'
                : !complete
                  ? 'withheld-missing-evidence'
                  : !enough
                    ? 'withheld-sample-size'
                    : 'descriptive-preregistered-comparison',
        }
      }),
    )
  return {
    schemaVersion: 1,
    experimentId: reg.experimentId,
    kind: reg.kind,
    costUnit: reg.costUnit,
    primaryMetric: reg.primaryMetric,
    deviations,
    arms: grouped,
    comparisons,
    qualityCost: schedule.map(s => {
      const r = bySlot.get(s.slot)
      return {
        slot: s.slot,
        armId: s.armId,
        split: s.split,
        familyId: s.familyId,
        rootSuccess: ['review-inconclusive', 'infrastructure-failure'].includes(r.outcome)
          ? null
          : Number(r.outcome === 'accepted' && r.hardGuards),
        costs: r.costs,
      }
    }),
  }
}

async function checkFrozen(base) {
  const reg = await load(join(base, 'registration.json')),
    freeze = await load(join(base, 'freeze.json'))
  requireThat(
    sha256(await readFile(join(base, 'registration.json'))) === freeze.registration,
    'registration changed after freeze',
  )
  requireThat(sha256(await readFile(join(base, 'source/state.json'))) === freeze.source, 'source snapshot changed')
  const source = await load(join(base, 'source/state.json'))
  requireThat(
    same(await files(join(base, 'source/tree')), Object.keys(source.files).sort()),
    'frozen source file set differs',
  )
  for (const [name, hash] of Object.entries(source.files))
    requireThat(sha256(await regularFile(join(base, 'source/tree'), name)) === hash, `source changed: ${name}`)
  await validateRegistration(reg, join(base, 'inputs'))
  requireThat(
    same(await load(join(base, 'schedule.json')), scheduleOf(reg)) &&
      sha256(await readFile(join(base, 'schedule.json'))) === freeze.schedule,
    'schedule changed after freeze',
  )
  return reg
}

export async function seal(prepared, resultsFile, inventoryFile, output, expectedFreezeSha256) {
  requireThat(
    /^[a-f0-9]{64}$/.test(expectedFreezeSha256) &&
      sha256(await readFile(join(prepared, 'freeze.json'))) === expectedFreezeSha256,
    'freeze identity differs from the independently registered pre-run SHA256',
  )
  const reg = await checkFrozen(prepared),
    records = await load(resultsFile)
  const report = aggregate(reg, records),
    inventory = await load(inventoryFile),
    base = dirname(resolve(inventoryFile))
  requireThat(inventory.schemaVersion === 1 && Array.isArray(inventory.files), 'evidence inventory required')
  unique(
    inventory.files.map(f => f.path),
    'inventory path',
  )
  const categories = [
    'control',
    'trajectory',
    'artifact',
    'findings',
    'measurement',
    'methods',
    'diffs',
    'consumption',
    'deterministic-recheck',
    'context',
  ]
  if (reg.kind === 'research')
    for (const category of categories)
      requireThat(
        inventory.files.some(f => f.category === category),
        `research evidence missing category ${category}`,
      )
  const available = new Map(inventory.files.map(f => [f.path, f]))
  for (const row of records)
    for (const ref of row.evidence)
      requireThat(available.get(ref.path)?.sha256 === ref.sha256, `trial evidence absent: ${ref.path}`)
  if (reg.kind === 'research') {
    const installed = hostInstall(),
      findings = hostFindings(installed)
    requireThat(!findings.length, findings.join('\n'))
    const sourceBaseline = await load(join(prepared, 'source/tree/dsh-baseline.json'))
    for (const [name, hash] of Object.entries(sourceBaseline.artifacts))
      requireThat(sha256(await regularFile(installed, name)) === hash, `frozen host mismatch ${name}`)
    requireThat(
      inventory.files.some(f => f.category === 'build'),
      'supply frozen build.json with build category',
    )
    // Generated bundles are ignored by Git: verify the supplied build against frozen source below.
  }
  if (records.some(r => scheduleOf(reg)[r.slot].split === 'heldout' && r.startedAt !== null)) {
    requireThat(
      inventory.analysisFreeze?.registration === sha256(json(reg)) && nonempty(inventory.analysisFreeze.frozenAt),
      'heldout requires prior analysis/method freeze',
    )
    const freezeTime = Date.parse(inventory.analysisFreeze.frozenAt)
    requireThat(Number.isFinite(freezeTime), 'invalid analysis freeze time')
    const methods = inventory.analysisFreeze.methods
    for (const arm of reg.arms) {
      const ref = methods?.[arm.id]
      requireThat(
        ref && available.get(ref.path)?.sha256 === ref.sha256,
        'champion/final method evidence required before heldout',
      )
      const assets = JSON.parse((await referenced(base, ref)).toString('utf8'))
      requireThat(ref.digest === digestOf(assets), 'final Method digest mismatch')
      if (arm.kind === 'skill-tool') {
        const initial = JSON.parse(
          (await referenced(join(prepared, 'inputs'), reg.arms.find(a => a.kind === 'frozen').method)).toString('utf8'),
        )
        requireThat(
          same(assets.templates, initial.templates) && assets.workflowGuidance === initial.workflowGuidance,
          'skill-tool candidate changed workflow/templates',
        )
      }
    }
    for (const row of records.filter(r => scheduleOf(reg)[r.slot].split === 'heldout' && r.startedAt !== null)) {
      requireThat(Date.parse(row.startedAt) >= freezeTime, 'heldout used before analysis freeze')
      requireThat(row.methodDigest === methods[row.armId].digest, 'heldout method differs from frozen champion')
    }
  }
  await mkdir(output, { recursive: false })
  for (const name of await files(prepared)) await put(output, name, await regularFile(prepared, name))
  await put(output, 'results.json', json(records))
  await put(output, 'report.json', json(report))
  await put(output, 'inventory.json', json(inventory))
  for (const ref of inventory.files) {
    const bytes = await referenced(base, ref)
    await put(output, `evidence/${ref.path}`, bytes)
    if (ref.category === 'build') {
      const build = JSON.parse(bytes.toString('utf8')),
        state = await load(join(prepared, 'source/state.json'))
      for (const [name, hash] of Object.entries(build.inputs))
        requireThat(state.files[name] === hash, `build source differs from frozen checkout: ${name}`)
      for (const [name, hash] of Object.entries(build.outputs))
        requireThat(
          inventory.files.some(f => f.path === name && f.sha256 === hash),
          `build output missing: ${name}`,
        )
    }
  }
  await put(output, 'REDACTION.json', json(reg.redaction))
  const hashes = Object.fromEntries(
    await Promise.all((await files(output)).map(async name => [name, sha256(await regularFile(output, name))])),
  )
  const manifest = { schemaVersion: 1, algorithm: 'sha256', files: hashes }
  await put(output, 'MANIFEST.json', json(manifest))
  const digest = sha256(json(manifest))
  await lockTree(output)
  return { output, manifestSha256: digest, kind: reg.kind }
}
async function lockTree(base) {
  for (const entry of await readdir(base, { withFileTypes: true })) {
    const name = join(base, entry.name)
    if (entry.isDirectory()) await lockTree(name)
    else await chmod(name, 0o444)
  }
  await chmod(base, 0o555)
}
export async function verifyPack(base, expectedDigest) {
  requireThat(
    /^[a-f0-9]{64}$/.test(expectedDigest),
    'external MANIFEST SHA256 required; a self-hash is not an authenticity check',
  )
  const bytes = await readFile(join(base, 'MANIFEST.json'))
  requireThat(sha256(bytes) === expectedDigest, 'manifest digest differs from externally retained identity')
  const manifest = JSON.parse(bytes.toString('utf8'))
  requireThat(manifest.schemaVersion === 1 && manifest.algorithm === 'sha256', 'unsupported manifest')
  const names = (await files(base)).filter(n => n !== 'MANIFEST.json')
  requireThat(same(names, Object.keys(manifest.files).sort()), 'manifest file set differs (added or omitted file)')
  for (const [name, hash] of Object.entries(manifest.files))
    requireThat(sha256(await regularFile(base, name)) === hash, `digest differs: ${name}`)
  const reg = await checkFrozen(base),
    records = await load(join(base, 'results.json'))
  const report = aggregate(reg, records)
  requireThat(same(report, await load(join(base, 'report.json'))), 'report does not reproduce from raw trial records')
  const inventory = await load(join(base, 'inventory.json'))
  for (const ref of inventory.files.filter(f => f.category === 'control')) {
    const { replayControl } = await import('./evidence-export.mjs')
    await replayControl(JSON.parse((await regularFile(join(base, 'evidence'), ref.path)).toString('utf8')))
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2)
  let result
  if (command === 'prepare' && args.length === 2) result = await prepare(...args)
  else if (command === 'seal' && args.length === 5) result = await seal(...args)
  else if (['verify', 'replay'].includes(command) && args.length === 2) result = await verifyPack(...args)
  else if (command === 'analyze' && args.length === 2) {
    const reg = await validateRegistration(await load(args[0]), dirname(resolve(args[0])))
    result = aggregate(reg, await load(args[1]))
  } else
    throw new Error(
      'Usage: experiment.mjs prepare registration.json new-directory | analyze registration.json results.json | seal prepared results.json inventory.json new-pack pre-run-freeze-sha256 | verify|replay pack external-manifest-sha256',
    )
  process.stdout.write(json(result))
}
