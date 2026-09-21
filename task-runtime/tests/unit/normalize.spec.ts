import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { TASK_CONTRACT_VERSION } from '../../../task/src/contract.ts'
import type { NormalizationContext, NormalizationResult } from '../../src/normalize.ts'
import { normalizeDecomposition } from '../../src/normalize.ts'

/**
 * The context one batch is normalized in. Its `admissionContext` is the limits
 * the caller resolved from configuration; nothing in it takes part in the
 * proposal digest (the digest covers what was asked for, the context records
 * the limits it was admitted under).
 */
const CONTEXT: NormalizationContext = {
  storeId: 'store-1',
  parentTaskId: 't-parent',
  parentRunId: 'r-parent',
  callerSessionId: 's-caller',
  admissionContext: { maxDepth: 4, maxChildren: 8, wallTimeMs: 120000, auditOnly: { maxToolCalls: 150, attempts: 1 } },
}

function batch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reason: 'split the work',
    children: [{ objective: 'child a', acceptanceCriteria: [{ description: 'child a works', command: 'true' }] }],
    ...overrides,
  }
}

/** The admitted batch, or a failure naming every reason the entry reported. */
function admitted(result: NormalizationResult) {
  if (!result.ok) throw new Error(`expected an admitted batch, got reasons:\n- ${result.reasons.join('\n- ')}`)
  return result.batch
}

/** The reasons of a rejected batch, one per line. */
function rejected(result: NormalizationResult): string {
  if (result.ok) throw new Error('expected a rejected batch')
  return result.reasons.join('\n')
}

describe('normalizeDecomposition', () => {
  test('fills every default and fixes the criterion ids from the batch position', () => {
    const normalized = admitted(normalizeDecomposition(batch({
      children: [
        {
          objective: '  child a  ',
          acceptanceCriteria: [{ description: 'it works', command: 'true' }],
          assumptions: ['a reference model exists'],
          constraints: ['no network'],
          requiredCapabilities: ['design-ball'],
        },
        { objective: 'child b', acceptanceCriteria: [{ description: 'a reviewer agrees' }], decomposable: true },
      ],
    }), CONTEXT))

    expect(normalized.contractVersion).toBe(TASK_CONTRACT_VERSION)
    // `toStrictEqual`, not `toEqual`: a criterion the contract emits must carry
    // no `undefined`-valued key, because the session log drops those and the
    // contract has to describe exactly what is persisted.
    expect(normalized.children[0]!.contract).toStrictEqual({
      contractVersion: TASK_CONTRACT_VERSION,
      objective: '  child a  ',
      acceptanceCriteria: [{
        criterionId: 'ac1-1',
        description: 'it works',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: 'true',
      }],
      assumptions: ['a reference model exists'],
      constraints: ['no network'],
      requiredCapabilities: ['design-ball'],
    })
    expect(normalized.children[1]!.contract).toStrictEqual({
      contractVersion: TASK_CONTRACT_VERSION,
      objective: 'child b',
      acceptanceCriteria: [{
        criterionId: 'ac2-1',
        description: 'a reviewer agrees',
        verificationMode: 'review',
        requiredEvidence: [],
        mandatory: true,
      }],
      assumptions: [],
      constraints: [],
      requiredCapabilities: [],
    })
    // The declaration is normalized, never invented: it decides whether the
    // child may split further; the caller's absence of one is `false`.
    expect(normalized.children.map(child => child.decomposable)).toEqual([false, true])
    expect(normalized.children.map(child => child.requiresIndependentAcceptance)).toEqual([false, false])
    expect(normalized.children[0]!.dependsOn).toEqual([])
  })

  test('defaults the mode only when none was declared: null and every other value are carried as declared', () => {
    const normalized = admitted(normalizeDecomposition(batch({
      children: [{
        objective: 'child a',
        acceptanceCriteria: [
          { description: 'a declared null mode', command: 'true', mode: null },
          { description: 'a declared numeric mode', command: 'true', mode: 0 },
        ],
      }],
    }), CONTEXT))

    // Absence is the only thing that means "not declared": every other value —
    // `null` included — is carried, so `contractDefects` refuses it by name
    // instead of this entry picking a judge the caller never asked for.
    expect(normalized.children[0]!.contract.acceptanceCriteria.map(criterion => criterion.verificationMode))
      .toEqual([null, 0])
    // The designed default still stands where no mode was declared at all: a
    // command means the verifier can execute it, no command means a reviewer
    // reads it.
    const defaults = admitted(normalizeDecomposition(batch({
      children: [{
        objective: 'child a',
        acceptanceCriteria: [{ description: 'has a command', command: 'true' }, { description: 'has none' }],
      }],
    }), CONTEXT))
    expect(defaults.children[0]!.contract.acceptanceCriteria.map(criterion => criterion.verificationMode))
      .toEqual(['deterministic', 'review'])
  })

  test('generates ac1-1, ac1-2, ac2-1 and keeps a declared id verbatim beside them', () => {
    const normalized = admitted(normalizeDecomposition(batch({
      children: [
        {
          objective: 'child a',
          acceptanceCriteria: [
            { description: 'first' },
            { description: 'second', criterionId: 'trace-equivalence' },
          ],
        },
        { objective: 'child b', acceptanceCriteria: [{ description: 'third' }] },
      ],
    }), CONTEXT))

    expect(normalized.children[0]!.contract.acceptanceCriteria.map(criterion => criterion.criterionId))
      .toEqual(['ac1-1', 'trace-equivalence'])
    expect(normalized.children[1]!.contract.acceptanceCriteria.map(criterion => criterion.criterionId))
      .toEqual(['ac2-1'])
    // An explicit id is what a parent-level childEvidence map can rely on, so it
    // is stored exactly as declared — never renumbered into the batch scheme.
    expect(normalized.children[0]!.contract.acceptanceCriteria[1]!.description).toBe('second')
  })

  test('refuses an unknown field at the batch, child, and criterion level', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['a batch-level budget', batch({ budget: 1_000_000 }), 'decomposition declares unknown field "budget"'],
      ['a batch-level depth', batch({ maxDepth: 99 }), 'decomposition declares unknown field "maxDepth"'],
      ['a child-level skill pin', { reason: 'r', children: [{ objective: 'a', acceptanceCriteria: [{ description: 'd' }], skills: ['ball-align'] }] },
        'child 0 declares unknown field "skills"'],
      ['a child-level budget', { reason: 'r', children: [{ objective: 'a', acceptanceCriteria: [{ description: 'd' }], tokens: 10 }] },
        'child 0 declares unknown field "tokens"'],
      ['a criterion-level budget', { reason: 'r', children: [{ objective: 'a', acceptanceCriteria: [{ description: 'd', budget: 5 }] }] },
        'child 0 criterion "ac1-1" declares unknown field "budget"'],
    ]
    for (const [label, spec, message] of cases) {
      // A field nobody understood is refused, never dropped silently: an attempt
      // to raise a budget or pin a skill rides this rule.
      expect(rejected(normalizeDecomposition(spec, CONTEXT)), label).toBe(message)
    }
  })

  test('refuses a contract version this build does not write, and accepts the current one', () => {
    expect(rejected(normalizeDecomposition(batch({ contractVersion: 2 }), CONTEXT)))
      .toBe(`unknown contract version 2: this runtime writes version ${TASK_CONTRACT_VERSION}`)
    // A declared version that is not even a number is refused the same way — the
    // message shows the value as declared, so "1" cannot pass for 1.
    expect(rejected(normalizeDecomposition(batch({ contractVersion: '1' }), CONTEXT)))
      .toBe(`unknown contract version "1": this runtime writes version ${TASK_CONTRACT_VERSION}`)
    expect(admitted(normalizeDecomposition(batch({ contractVersion: TASK_CONTRACT_VERSION }), CONTEXT)).contractVersion)
      .toBe(TASK_CONTRACT_VERSION)
  })

  test('refuses a blank or wrongly typed value the contract has no field for', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['a missing reason', { children: [{ objective: 'a', acceptanceCriteria: [{ description: 'd' }] }] },
        'decomposition requires a non-blank reason'],
      ['a blank reason', batch({ reason: '   ' }), 'decomposition requires a non-blank reason'],
      ['a blank objective', { reason: 'r', children: [{ objective: '   ', acceptanceCriteria: [{ description: 'd' }] }] },
        'child 0 objective must be a non-empty string'],
      ['a non-string objective', { reason: 'r', children: [{ objective: 42, acceptanceCriteria: [{ description: 'd' }] }] },
        'child 0 objective must be a non-empty string'],
      ['a blank description', { reason: 'r', children: [{ objective: 'a', acceptanceCriteria: [{ description: '' }] }] },
        'child 0 criterion "ac1-1" description must be a non-empty string'],
      ['a blank assumption', { reason: 'r', children: [{ objective: 'a', acceptanceCriteria: [{ description: 'd' }], assumptions: ['  '] }] },
        'child 0 assumptions must be an array of non-empty strings'],
      ['a blank constraint', { reason: 'r', children: [{ objective: 'a', acceptanceCriteria: [{ description: 'd' }], constraints: [''] }] },
        'child 0 constraints must be an array of non-empty strings'],
      ['a blank capability name', { reason: 'r', children: [{ objective: 'a', acceptanceCriteria: [{ description: 'd' }], requiredCapabilities: [' '] }] },
        'child 0 requiredCapabilities must be an array of non-empty strings'],
      ['a non-boolean decomposable', { reason: 'r', children: [{ objective: 'a', acceptanceCriteria: [{ description: 'd' }], decomposable: 'yes' }] },
        'child 0 decomposable must be a boolean'],
      ['a non-integer dependency', { reason: 'r', children: [{ objective: 'a', acceptanceCriteria: [{ description: 'd' }], dependsOn: [0.5] }] },
        'child 0 dependsOn must be an array of integers'],
      ['a blank criterion id', { reason: 'r', children: [{ objective: 'a', acceptanceCriteria: [{ description: 'd', criterionId: ' ' }] }] },
        'child 0 criterion 1 criterionId must be a non-empty string'],
      ['a non-boolean mandatory', { reason: 'r', children: [{ objective: 'a', acceptanceCriteria: [{ description: 'd', mandatory: 'yes' }] }] },
        'child 0 criterion "ac1-1" mandatory must be a boolean'],
      ['a non-array criterion list', { reason: 'r', children: [{ objective: 'a', acceptanceCriteria: { description: 'd' } }] },
        'child 0 acceptanceCriteria must be an array'],
      ['a child that is not an object', { reason: 'r', children: ['child a'] }, 'child 0 must be an object'],
      ['a criterion that is not an object', { reason: 'r', children: [{ objective: 'a', acceptanceCriteria: ['criterion'] }] },
        'child 0 criterion 1 must be an object'],
    ]
    for (const [label, spec, message] of cases) {
      expect(rejected(normalizeDecomposition(spec, CONTEXT)), label).toBe(message)
    }
  })

  test('reports every defect of a batch instead of stopping at the first', () => {
    const reasons = rejected(normalizeDecomposition({
      reason: 'r',
      children: [
        { objective: '', acceptanceCriteria: [] },
        { objective: 'child b', acceptanceCriteria: [{ description: ' ' }], assumptions: ['x', ''] },
      ],
    }, CONTEXT)).split('\n')

    expect(reasons).toEqual([
      'child 0 objective must be a non-empty string',
      'child 1 criterion "ac2-1" description must be a non-empty string',
      'child 1 assumptions must be an array of non-empty strings',
    ])
  })

  test('refuses a batch without children', () => {
    expect(rejected(normalizeDecomposition({ reason: 'r', children: [] }, CONTEXT)))
      .toBe('decomposition requires at least one child')
    expect(rejected(normalizeDecomposition({ reason: 'r' }, CONTEXT)))
      .toBe('decomposition requires at least one child')
    expect(rejected(normalizeDecomposition({ reason: 'r', children: 'child a' }, CONTEXT)))
      .toBe('decomposition children must be an array')
  })

  test('refuses a criterion id declared twice inside one child, generated or declared', () => {
    expect(rejected(normalizeDecomposition(batch({
      children: [{
        objective: 'child a',
        acceptanceCriteria: [
          { description: 'first', criterionId: 'dup' },
          { description: 'second', criterionId: 'dup' },
        ],
      }],
    }), CONTEXT))).toBe('child 0 declares criterion id "dup" more than once')

    // The auto-numbering scheme collides with a declared id that spells one of
    // its own names: a real duplicate in the batch, not a fabricated one — the
    // legacy adapter never invents the same id twice on its own.
    expect(rejected(normalizeDecomposition(batch({
      children: [{
        objective: 'child a',
        acceptanceCriteria: [{ description: 'first', criterionId: 'ac1-2' }, { description: 'second' }],
      }],
    }), CONTEXT))).toBe('child 0 declares criterion id "ac1-2" more than once')
    expect(rejected(normalizeDecomposition(batch({
      children: [{
        objective: 'child a',
        acceptanceCriteria: [
          { description: 'first', criterionId: 'dup' },
          { description: 'second', criterionId: 'dup' },
          { description: 'third', criterionId: 'dup' },
        ],
      }],
    }), CONTEXT))).toBe('child 0 declares criterion id "dup" more than once')
  })

  test('two spellings of the same proposal normalize to one digest', () => {
    const spelledOut = admitted(normalizeDecomposition(batch({
      children: [{
        objective: 'child a',
        acceptanceCriteria: [{
          description: 'child a works',
          command: 'true',
          mode: 'deterministic',
          mandatory: true,
          requiredEvidence: [],
        }],
        assumptions: [],
        constraints: [],
        requiredCapabilities: [],
        dependsOn: [],
        decomposable: false,
        requiresIndependentAcceptance: false,
      }],
    }), CONTEXT))

    // The omitted defaults, `[]` for an omitted collection, and a different
    // object key order are the same proposal.
    const omitted = admitted(normalizeDecomposition({
      children: [{ acceptanceCriteria: [{ command: 'true', description: 'child a works' }], objective: 'child a' }],
      reason: 'split the work',
    }, CONTEXT))
    const emptyCollections = admitted(normalizeDecomposition(batch({
      children: [{
        objective: 'child a',
        acceptanceCriteria: [{ description: 'child a works', command: 'true' }],
        assumptions: [],
        constraints: [],
      }],
    }), CONTEXT))

    expect(omitted.admission.proposalDigest).toBe(spelledOut.admission.proposalDigest)
    expect(emptyCollections.admission.proposalDigest).toBe(spelledOut.admission.proposalDigest)
    expect(omitted.admission.proposalDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  test('any change of the proposal content or its array order is a different digest', () => {
    const first = { objective: 'child a', acceptanceCriteria: [{ description: 'child a works', command: 'true' }] }
    const second = { objective: 'child b', acceptanceCriteria: [{ description: 'child b works', command: 'true' }], dependsOn: [0] }
    const baseline = admitted(normalizeDecomposition({ reason: 'split the work', children: [first, second] }, CONTEXT))
      .admission.proposalDigest

    const variants: Array<[string, Record<string, unknown>]> = [
      ['the children reordered', { reason: 'split the work', children: [second, first] }],
      ['a criterion added', {
        reason: 'split the work',
        children: [
          { objective: 'child a', acceptanceCriteria: [first.acceptanceCriteria[0], { description: 'and review it' }] },
          second,
        ],
      }],
      ['a criterion description changed', {
        reason: 'split the work',
        children: [{ objective: 'child a', acceptanceCriteria: [{ description: 'child a passes', command: 'true' }] }, second],
      }],
      ['the criteria reordered', {
        reason: 'split the work',
        children: [{ objective: 'child a', acceptanceCriteria: [{ description: 'and review it' }, first.acceptanceCriteria[0]] }, second],
      }],
      ['a constraint added', {
        reason: 'split the work',
        children: [{ objective: 'child a', acceptanceCriteria: first.acceptanceCriteria, constraints: ['no network'] }, second],
      }],
      ['an assumption added', {
        reason: 'split the work',
        children: [{ objective: 'child a', acceptanceCriteria: first.acceptanceCriteria, assumptions: ['a reference exists'] }, second],
      }],
      ['a dependency changed', {
        reason: 'split the work',
        children: [first, { ...second, dependsOn: [] }],
      }],
      ['a capability requirement added', {
        reason: 'split the work',
        children: [{ objective: 'child a', acceptanceCriteria: first.acceptanceCriteria, requiredCapabilities: ['design-ball'] }, second],
      }],
      ['the decomposable declaration flipped', {
        reason: 'split the work',
        children: [{ ...first, decomposable: true }, second],
      }],
      ['the reason changed', { reason: 'split the work differently', children: [first, second] }],
    ]
    for (const [label, spec] of variants) {
      expect(admitted(normalizeDecomposition(spec, CONTEXT)).admission.proposalDigest, label).not.toBe(baseline)
    }
  })

  test('the digest covers where the proposal came from', () => {
    const spec = batch()
    const digestOf = (context: Partial<NormalizationContext>) =>
      admitted(normalizeDecomposition(spec, { ...CONTEXT, ...context })).admission.proposalDigest

    const baseline = digestOf({})
    expect(digestOf({ storeId: 'store-2' })).not.toBe(baseline)
    expect(digestOf({ parentTaskId: 't-other' })).not.toBe(baseline)
    expect(digestOf({ parentRunId: 'r-other' })).not.toBe(baseline)
    expect(digestOf({ callerSessionId: 's-other' })).not.toBe(baseline)
    // The limits are recorded with the batch, never folded into its content
    // identity: the context's own fingerprint is the review gate's business.
    expect(digestOf({ admissionContext: { maxDepth: 1, maxChildren: 1, auditOnly: {} } })).toBe(baseline)
  })

  test('records the limits it was admitted under, as its own copy', () => {
    const normalized = admitted(normalizeDecomposition(batch(), CONTEXT))
    expect(normalized.admission.context).toEqual(CONTEXT.admissionContext)
    expect(normalized.admission.context).not.toBe(CONTEXT.admissionContext)
  })

  test('returns a fresh contract: mutating the input afterwards changes nothing', () => {
    const input = batch({
      children: [{
        objective: 'child a',
        acceptanceCriteria: [{
          description: 'child a works',
          command: 'true',
          requiredEvidence: ['unit-log'],
          childEvidence: [{ childIndex: 0, criterionId: 'ac1-1' }],
        }],
        assumptions: ['a reference exists'],
        constraints: ['no network'],
        requiredCapabilities: ['design-ball'],
        dependsOn: [0],
      }],
    })
    const untouched = structuredClone(input)
    const normalized = admitted(normalizeDecomposition(input, CONTEXT))
    const contract = normalized.children[0]!.contract

    const child = (input.children as Array<Record<string, unknown>>)[0]!
    child.objective = 'rewritten'
    ;(child.assumptions as string[]).push('a second assumption')
    ;(child.constraints as string[]).length = 0
    ;(child.requiredCapabilities as string[]).push('run-bemu-regression')
    ;(child.dependsOn as number[]).push(1)
    const criterion = (child.acceptanceCriteria as Array<Record<string, unknown>>)[0]!
    criterion.description = 'rewritten'
    ;(criterion.requiredEvidence as string[]).push('extra')
    ;((criterion.childEvidence as Array<Record<string, unknown>>)[0]!).criterionId = 'rewritten'

    expect(contract).toEqual(admitted(normalizeDecomposition(untouched, CONTEXT)).children[0]!.contract)
    expect(contract.objective).toBe('child a')
    expect(contract.assumptions).toEqual(['a reference exists'])
    expect(contract.constraints).toEqual(['no network'])
    expect(contract.requiredCapabilities).toEqual(['design-ball'])
    expect(contract.acceptanceCriteria[0]!.description).toBe('child a works')
    expect(contract.acceptanceCriteria[0]!.requiredEvidence).toEqual(['unit-log'])
    expect(contract.acceptanceCriteria[0]!.childEvidence).toEqual([{ childIndex: 0, criterionId: 'ac1-1' }])
    expect(normalized.children[0]!.dependsOn).toEqual([0])
  })

  test('passes a P4 declaration through as declared: its shape is admission\'s judgement', () => {
    const normalized = admitted(normalizeDecomposition(batch({
      children: [{ objective: 'child a', acceptanceCriteria: [{ description: 'child a works', command: 'true', childEvidence: 'ac1-1' }] }],
    }), CONTEXT))
    // `independentAcceptanceDefects` owns every childEvidence shape rule
    // (`admission.ts`), so this entry does not duplicate them — it only refuses
    // a batch the digest cannot describe.
    expect(normalized.children[0]!.contract.acceptanceCriteria[0]!.childEvidence).toBe('ac1-1')
  })

  test('a fixed vector: the proposal digest is SHA-256 over the canonical identity', () => {
    // The expectation is written out by hand — canonical JSON of the contract
    // and of the identity — so this pins the identity's composition without
    // asking the implementation what it should be.
    const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
    const contractDigest = sha256([
      '{"acceptanceCriteria":[{"command":"true","criterionId":"ac1-1","description":"child a works",',
      '"mandatory":true,"requiredEvidence":[],"verificationMode":"deterministic"}],',
      '"assumptions":[],"constraints":[],"contractVersion":1,"objective":"child a","requiredCapabilities":[]}',
    ].join(''))

    expect(admitted(normalizeDecomposition(batch(), CONTEXT)).admission.proposalDigest).toBe(sha256([
      '{"callerSessionId":"s-caller","children":[',
      `{"contractDigest":"${contractDigest}","decomposable":false,"dependsOn":[],"requiresIndependentAcceptance":false}`,
      '],"contractVersion":1,"parentRunId":"r-parent","parentTaskId":"t-parent","reason":"split the work","storeId":"store-1"}',
    ].join('')))
  })

  test('never throws on malformed input: every shape is a refusal with reasons', () => {
    const malformed: unknown[] = [
      undefined,
      null,
      42,
      'a batch',
      [],
      {},
      { reason: 'r', children: [null] },
      { reason: 'r', children: [[{ objective: 'a' }]] },
      { reason: 42, children: [{ objective: 'a', acceptanceCriteria: [{ description: 'd' }] }] },
      { reason: 'r', children: [{ objective: 'a', acceptanceCriteria: [{ description: 'd', requiredEvidence: 'log' }] }] },
      { reason: 'r', children: [{ objective: 'a', acceptanceCriteria: [{ description: 'd' }], dependsOn: 'first' }] },
    ]
    for (const spec of malformed) {
      const result = normalizeDecomposition(spec, CONTEXT)
      expect(result.ok, JSON.stringify(spec)).toBe(false)
      if (!result.ok) expect(result.reasons.length, JSON.stringify(spec)).toBeGreaterThan(0)
    }
  })

  test('refuses a proposal whose content no canonical form can carry', () => {
    // JSON cannot round-trip a function, so no digest of it could be compared
    // with a digest of a different value: the batch is refused, never hashed.
    const reasons = rejected(normalizeDecomposition(batch({
      children: [{ objective: 'child a', acceptanceCriteria: [{ description: 'child a works', command: () => true }] }],
    }), CONTEXT))
    expect(reasons).toContain('decomposition content cannot be canonicalized')
    expect(reasons).toContain('cannot canonicalize')
  })
})
