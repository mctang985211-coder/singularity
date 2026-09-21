import { describe, expect, test } from 'vitest'
import {
  TASK_CONTRACT_VERSION,
  canonicalize,
  contractDigest,
  decompositionDigest,
} from '../../src/contract.ts'
import type { DecompositionIdentity, TaskContract } from '../../src/contract.ts'

/**
 * The expected digests below are fixed vectors: the canonical text they cover
 * is written out in the test and its SHA-256 was computed outside this
 * repository (`sha256sum` over that exact byte sequence), so a change in
 * either the serialization or the hashing shows up here instead of being
 * confirmed by the implementation against itself.
 */
const CANONICAL_OBJECT = '{"a":{"c":"C\\n","d":2},"b":[1,"x"]}'
const CANONICAL_OBJECT_SHA256 = '714ab8a1c7220719255dfa2dd669cca9524321418bc48a4f70683f9c94613f7f'

const CONTRACT: TaskContract = {
  contractVersion: 1,
  objective: 'ship the release',
  acceptanceCriteria: [
    {
      criterionId: 'ac1-1',
      description: 'the suite passes',
      verificationMode: 'deterministic',
      requiredEvidence: [],
      mandatory: true,
      command: 'pnpm test',
    },
  ],
  assumptions: ['the checkout is clean'],
  constraints: ['no network access'],
  requiredCapabilities: ['research'],
}

const CONTRACT_CANONICAL = [
  '{"acceptanceCriteria":[{"command":"pnpm test","criterionId":"ac1-1","description":"the suite passes",',
  '"mandatory":true,"requiredEvidence":[],"verificationMode":"deterministic"}],"assumptions":["the checkout is clean"],',
  '"constraints":["no network access"],"contractVersion":1,"objective":"ship the release","requiredCapabilities":["research"]}',
].join('')
const CONTRACT_SHA256 = 'aeaeebd25a34d2823ff63687d54fb1a55864cfa38c01574134634b54cbbd18bc'

const IDENTITY: DecompositionIdentity = {
  contractVersion: TASK_CONTRACT_VERSION,
  storeId: 'sg-t-root',
  parentTaskId: 't-parent',
  parentRunId: 'r-parent',
  callerSessionId: 's-root',
  reason: 'split the work',
  children: [
    { contractDigest: 'aa11', dependsOn: [], decomposable: false, requiresIndependentAcceptance: false },
    { contractDigest: 'bb22', dependsOn: [0], decomposable: true, requiresIndependentAcceptance: true },
  ],
}

const IDENTITY_CANONICAL = [
  '{"callerSessionId":"s-root","children":[{"contractDigest":"aa11","decomposable":false,"dependsOn":[],',
  '"requiresIndependentAcceptance":false},{"contractDigest":"bb22","decomposable":true,"dependsOn":[0],',
  '"requiresIndependentAcceptance":true}],"contractVersion":1,"parentRunId":"r-parent","parentTaskId":"t-parent",',
  '"reason":"split the work","storeId":"sg-t-root"}',
].join('')
const IDENTITY_SHA256 = 'c2c71c42917d1a62b126be26572baf6d9bd09a97ca7d47686abf030296b4d9a3'

describe('task contract canonicalization', () => {
  test('serializes object keys in one order, whatever order they were written in', () => {
    expect(canonicalize({ b: [1, 'x'], a: { d: 2, c: 'C\n' }, skipped: undefined })).toBe(CANONICAL_OBJECT)
    expect(canonicalize({ skipped: undefined, a: { c: 'C\n', d: 2 }, b: [1, 'x'] })).toBe(CANONICAL_OBJECT)
  })

  test('keeps arrays in order and strings byte-for-byte', () => {
    expect(canonicalize(['second', 'first'])).toBe('["second","first"]')
    expect(canonicalize([' first '])).toBe('[" first "]')
    expect(canonicalize(['a\nb'])).toBe('["a\\nb"]')
  })

  test('drops undefined-valued keys the way the session log does, and keeps array holes as null', () => {
    expect(canonicalize({ kept: 1, dropped: undefined })).toBe('{"kept":1}')
    expect(canonicalize([1, undefined])).toBe('[1,null]')
  })

  test('refuses values the session log cannot round-trip', () => {
    expect(() => canonicalize({ value: Number.NaN })).toThrow(/cannot canonicalize/)
    expect(() => canonicalize({ value: Number.POSITIVE_INFINITY })).toThrow(/cannot canonicalize/)
    expect(() => canonicalize({ value: () => 'x' })).toThrow(/cannot canonicalize a function/)
    expect(() => canonicalize({ value: new Date() })).toThrow(/cannot canonicalize/)
  })

  test('hashes the canonical text, not the value the caller happened to hold', () => {
    // The digest is pinned against the canonical string written above, and the
    // independent sha256 of that exact text is asserted beside it, so neither
    // half can drift without the other.
    expect(contractDigest(CONTRACT)).toBe(CONTRACT_SHA256)
    expect(canonicalize(CONTRACT)).toBe(CONTRACT_CANONICAL)
  })
})

describe('decomposition identity', () => {
  test('hashes the normalized proposal, not key order or caller-side spelling', () => {
    const reordered: DecompositionIdentity = {
      reason: 'split the work',
      children: [
        { requiresIndependentAcceptance: false, decomposable: false, dependsOn: [], contractDigest: 'aa11' },
        { dependsOn: [0], contractDigest: 'bb22', requiresIndependentAcceptance: true, decomposable: true },
      ],
      callerSessionId: 's-root',
      parentRunId: 'r-parent',
      parentTaskId: 't-parent',
      storeId: 'sg-t-root',
      contractVersion: 1,
    }
    expect(decompositionDigest(IDENTITY)).toBe(IDENTITY_SHA256)
    expect(decompositionDigest(reordered)).toBe(IDENTITY_SHA256)
    expect(canonicalize(IDENTITY)).toBe(IDENTITY_CANONICAL)
  })

  test('moves when the content moves: dependency order, a child, the reason', () => {
    const base = decompositionDigest(IDENTITY)
    const swapped = decompositionDigest({
      ...IDENTITY,
      children: [
        { contractDigest: 'bb22', dependsOn: [1], decomposable: true, requiresIndependentAcceptance: true },
        { contractDigest: 'aa11', dependsOn: [], decomposable: false, requiresIndependentAcceptance: false },
      ],
    })
    const oneChild = decompositionDigest({ ...IDENTITY, children: [IDENTITY.children[0]!] })
    const otherReason = decompositionDigest({ ...IDENTITY, reason: 'split the work differently' })
    const otherContract = decompositionDigest({
      ...IDENTITY,
      children: [{ ...IDENTITY.children[0]!, contractDigest: 'aa12' }, IDENTITY.children[1]!],
    })
    for (const digest of [swapped, oneChild, otherReason, otherContract]) {
      expect(digest).not.toBe(base)
    }
  })

  test('covers exactly the proposal surface: ids minted at admission are not in it', () => {
    // Task ids, run ids and session ids of the *runs* are minted after the
    // proposal is judged, so they cannot be part of what the identity covers —
    // a retry of the same proposal must hash the same bytes. The covered key
    // set is pinned here so extending the identity is a deliberate act.
    expect(Object.keys(JSON.parse(canonicalize(IDENTITY)) as Record<string, unknown>)).toEqual([
      'callerSessionId', 'children', 'contractVersion', 'parentRunId', 'parentTaskId', 'reason', 'storeId',
    ])
    expect(Object.keys(JSON.parse(canonicalize(IDENTITY.children[1])) as Record<string, unknown>)).toEqual([
      'contractDigest', 'decomposable', 'dependsOn', 'requiresIndependentAcceptance',
    ])
  })
})

describe('contract digest sensitivity', () => {
  test('assumptions, constraints and capabilities are inside the identity', () => {
    const base = contractDigest(CONTRACT)
    expect(contractDigest({ ...CONTRACT, assumptions: ['the checkout is clean', 'the toolchain is pinned'] })).not.toBe(base)
    expect(contractDigest({ ...CONTRACT, constraints: ['no network access', 'no writes outside the checkout'] })).not.toBe(base)
    expect(contractDigest({ ...CONTRACT, requiredCapabilities: ['research', 'verify-ball-functional'] })).not.toBe(base)
  })

  test('criterion order and criterion content are inside the identity', () => {
    const second = {
      criterionId: 'ac1-2',
      description: 'the build is clean',
      verificationMode: 'deterministic' as const,
      requiredEvidence: [],
      mandatory: true,
      command: 'pnpm build',
    }
    const two = contractDigest({ ...CONTRACT, acceptanceCriteria: [CONTRACT.acceptanceCriteria[0]!, second] })
    const reversed = contractDigest({ ...CONTRACT, acceptanceCriteria: [second, CONTRACT.acceptanceCriteria[0]!] })
    const renamed = contractDigest({
      ...CONTRACT,
      acceptanceCriteria: [{ ...CONTRACT.acceptanceCriteria[0]!, criterionId: 'ac1-9' }],
    })
    const loosened = contractDigest({
      ...CONTRACT,
      acceptanceCriteria: [{ ...CONTRACT.acceptanceCriteria[0]!, mandatory: false }],
    })
    for (const digest of [two, reversed, renamed, loosened]) expect(digest).not.toBe(contractDigest(CONTRACT))
    expect(reversed).not.toBe(two)
  })
})
