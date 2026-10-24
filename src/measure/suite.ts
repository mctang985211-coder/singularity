import { assertClosedKeys, digestOf } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { assertContract, type TaskContract } from '../task/contract.ts'
import type { RevisionRef } from '../task/protocol.ts'

export type Split = 'evolve' | 'validation' | 'heldout'
export interface TaskCase {
  readonly caseId: string
  readonly familyId: string
  readonly sourceId: string
  readonly split: Split
  readonly weight: number
  readonly trials: number
  readonly contract: TaskContract
  /** Ordinary task failure is scored; only these standards are non-compensating guards. */
  readonly hardGuards: readonly string[]
}
export interface Suite {
  readonly version: 1
  readonly suiteId: string
  readonly cases: readonly TaskCase[]
  readonly failureQuality: number
  /** Opt in to passed non-guard criteria / planned non-guard criteria. Default: whole-task pass. */
  readonly scoring?: 'criteria'
}
export interface TrialSlot {
  readonly caseId: string
  readonly familyId: string
  readonly contractDigest: string
  readonly trial: number
  readonly weight: number
}
export interface EvaluationMatrix {
  readonly suiteDigest: string
  readonly executionProfileDigest: string
  readonly split: Split
  readonly slots: readonly TrialSlot[]
}
const label = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) refuse('malformed-declaration', `${name} must be nonempty`)
  return value
}
export function parseSuite(raw: unknown): Suite {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('malformed-declaration', 'suite must be an object')
  const row = raw as Record<string, unknown>
  assertClosedKeys(row, ['version', 'suiteId', 'cases', 'failureQuality', 'scoring'], 'suite', 'malformed-declaration')
  if (row.scoring !== undefined && row.scoring !== 'criteria') refuse('malformed-declaration', 'unknown suite scoring')
  if (row.scoring === 'criteria' && row.failureQuality !== 0)
    refuse('malformed-declaration', 'criteria scoring requires failureQuality 0')
  if (
    row.version !== 1 ||
    !Array.isArray(row.cases) ||
    row.cases.length === 0 ||
    typeof row.failureQuality !== 'number' ||
    !Number.isFinite(row.failureQuality)
  )
    refuse('malformed-declaration', 'suite requires version 1, cases and a finite failureQuality')
  const cases = row.cases.map((raw, i): TaskCase => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      refuse('malformed-declaration', `case ${i} must be an object`)
    const c = raw as Record<string, unknown>
    assertClosedKeys(
      c,
      ['caseId', 'familyId', 'sourceId', 'split', 'weight', 'trials', 'contract', 'hardGuards'],
      'case',
      'malformed-declaration',
    )
    if (!['evolve', 'validation', 'heldout'].includes(String(c.split)))
      refuse('malformed-declaration', 'unknown case split')
    if (
      typeof c.weight !== 'number' ||
      !Number.isFinite(c.weight) ||
      c.weight <= 0 ||
      !Number.isSafeInteger(c.trials) ||
      (c.trials as number) < 1
    )
      refuse('malformed-declaration', 'case weight and trials must be positive')
    const contract = assertContract(c.contract, `case ${i}.contract`)
    if (contract.inputs.some(input => input.source.kind !== 'protected'))
      refuse('malformed-declaration', 'suite cases require frozen protected inputs')
    if (
      !Array.isArray(c.hardGuards) ||
      c.hardGuards.some(
        id => typeof id !== 'string' || !contract.criteria.some(criterion => criterion.criterionId === id),
      ) ||
      new Set(c.hardGuards).size !== c.hardGuards.length
    )
      refuse('malformed-declaration', 'hardGuards must name unique contract criteria')
    if (
      row.scoring === 'criteria' &&
      contract.criteria.every(criterion => (c.hardGuards as string[]).includes(criterion.criterionId))
    )
      refuse('malformed-declaration', 'criteria scoring requires a non-guard criterion in every case')
    return {
      caseId: label(c.caseId, 'caseId'),
      familyId: label(c.familyId, 'familyId'),
      sourceId: label(c.sourceId, 'sourceId'),
      split: c.split as Split,
      weight: c.weight,
      trials: c.trials as number,
      contract,
      hardGuards: c.hardGuards as string[],
    }
  })
  if (
    new Set(cases.map(c => c.caseId)).size !== cases.length ||
    new Set(cases.map(c => digestOf(c.contract))).size !== cases.length
  )
    refuse('malformed-declaration', 'duplicate case identity or contract')
  for (const field of ['familyId', 'sourceId'] as const) {
    const splits = new Map<string, Split>()
    for (const c of cases) {
      if (splits.has(c[field]) && splits.get(c[field]) !== c.split)
        refuse('malformed-declaration', `${field} ${c[field]} overlaps splits`)
      splits.set(c[field], c.split)
    }
  }
  // A returned suite is a value, never a mutable caller-owned experiment specification.
  return JSON.parse(
    JSON.stringify({
      version: 1,
      suiteId: label(row.suiteId, 'suiteId'),
      failureQuality: row.failureQuality,
      ...(row.scoring === undefined ? {} : { scoring: row.scoring }),
      cases,
    }),
  ) as Suite
}
export function matrixOf(suite: Suite, split: Split, executionProfileDigest: string): EvaluationMatrix {
  if (!/^[a-f0-9]{64}$/.test(executionProfileDigest))
    refuse('malformed-declaration', 'executionProfileDigest must be sha256')
  const slots = suite.cases
    .filter(c => c.split === split)
    .flatMap(c =>
      Array.from({ length: c.trials }, (_, trial) => ({
        caseId: c.caseId,
        familyId: c.familyId,
        contractDigest: digestOf(c.contract),
        trial,
        weight: c.weight / c.trials,
      })),
    )
  if (slots.length === 0) refuse('malformed-declaration', `suite has no ${split} cases`)
  return { suiteDigest: digestOf(suite), executionProfileDigest, split, slots }
}
export function trialKey(
  matrix: EvaluationMatrix,
  revision: RevisionRef,
  slot: TrialSlot,
  operationId: string,
): string {
  return digestOf({
    operationId,
    suite: matrix.suiteDigest,
    profile: matrix.executionProfileDigest,
    split: matrix.split,
    revision,
    slot,
  })
}
