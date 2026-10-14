import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { assertClosedKeys, digestOf } from '../protocol/envelope.ts'
import { defineKind, type ProtocolRegistry } from '../protocol/registry.ts'
import { refuse } from '../protocol/refusal.ts'
import { record, text, digest } from '../task/shape.ts'
import type { AcceptanceCriterion, VerifierCriterion } from '../task/contract.ts'
import type { DecompositionChild } from '../task/decomposition.ts'
import { assertDecomposition } from '../task/decomposition.ts'
import type { Bubble } from '../task/bubble.ts'
import type { RevisionRef } from '../task/protocol.ts'

export const REVIEW_PROTOCOL = 'review'
export const REVIEW_VERSION = 2
export const REVIEW_ROLE = 'verifier:independent-review@1'
export const REVIEW_DIGEST = digestOf({ protocol: REVIEW_PROTOCOL, version: REVIEW_VERSION })
export const reviewCriterion = (criterion: AcceptanceCriterion): VerifierCriterion => ({
  ...criterion,
  verifierRef: 'independent-review',
  verifierVersion: '1',
  implementationDigest: REVIEW_DIGEST,
})
export type ReviewTarget =
  | {
      readonly kind: 'acceptance'
      readonly taskId: string
      readonly runId: string
      readonly contractDigest: string
      readonly artifactDigest: string
    }
  | {
      readonly kind: 'publication'
      readonly environmentId: string
      readonly revisionId: string
      readonly draftDigest: string
      readonly assetsDigest: string
    }
export interface Finding {
  readonly criterionId: string
  readonly verdict: 'pass' | 'fail' | 'partial' | 'unknown'
  readonly detail: string
  readonly evidence: readonly string[]
}
export interface ReviewRun {
  readonly reviewId: string
  readonly target: ReviewTarget
  readonly subject: FileAttachmentRef
  readonly subjectDigest: string
  readonly criteria: readonly AcceptanceCriterion[]
  readonly agentId: string
  readonly identity: string
  readonly sessionId: string
  readonly workspace: string
  readonly model: Bubble['model']
  readonly method: RevisionRef
  readonly status: 'running' | 'completed' | 'failed'
  readonly children: readonly DecompositionChild[]
  readonly findings?: readonly Finding[]
  readonly result?: FileAttachmentRef
  readonly failure?: string
}
export function readFindings(raw: unknown): readonly Finding[] {
  if (!Array.isArray(raw)) refuse('malformed-payload', 'review findings must be an array')
  const ids = new Set<string>()
  return raw.map((raw) => {
    const row = record(raw, 'finding')
    assertClosedKeys(row, ['criterionId', 'verdict', 'detail', 'evidence'], 'finding')
    const verdict = row['verdict']
    if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'partial' && verdict !== 'unknown')
      refuse('malformed-payload', 'unknown review verdict')
    const criterionId = text(row, 'criterionId', 'finding')
    if (ids.has(criterionId)) refuse('evidence-conflict', 'duplicate review finding')
    ids.add(criterionId)
    const evidence = row['evidence']
    if (!Array.isArray(evidence) || evidence.some((ref) => typeof ref !== 'string' || ref.length === 0))
      refuse('malformed-payload', 'finding evidence must contain references')
    return { criterionId, verdict, detail: text(row, 'detail', 'finding'), evidence: evidence as string[] }
  })
}
export function declareReviewProtocol(registry: ProtocolRegistry): void {
  registry.declare<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, {
    initialState: {} as ReviewRun,
    kinds: {
      'review/started': defineKind<ReviewRun, Omit<ReviewRun, 'reviewId' | 'status' | 'children'>, {}>({
        guarantees: { appended: true },
        emitter: 'scheduler',
        members: [
          'target',
          'subject',
          'subjectDigest',
          'criteria',
          'agentId',
          'identity',
          'sessionId',
          'workspace',
          'model',
          'method',
        ],
        nested: {},
        parse: (raw, where) => {
          const row = record(raw, where)
          const target = record(row['target'], 'review target')
          const kind = text(target, 'kind', 'review target')
          if (kind !== 'acceptance' && kind !== 'publication') refuse('malformed-payload', 'unknown review target')
          assertClosedKeys(
            target,
            kind === 'acceptance'
              ? ['kind', 'taskId', 'runId', 'contractDigest', 'artifactDigest']
              : ['kind', 'environmentId', 'revisionId', 'draftDigest', 'assetsDigest'],
            'review target',
          )
          for (const key of Object.keys(target))
            key.endsWith('Digest') ? digest(target, key, 'review target') : text(target, key, 'review target')
          const subject = record(row['subject'], 'review subject')
          assertClosedKeys(subject, ['attachmentId', 'name', 'bytes'], 'review subject')
          if (
            subject['attachmentId'] !== `sha256:${digest(row, 'subjectDigest', where)}` ||
            !Number.isSafeInteger(subject['bytes']) ||
            (subject['bytes'] as number) < 0
          )
            refuse('digest-mismatch', 'review subject must name its frozen bytes')
          text(subject, 'name', 'review subject')
          const criteria = row['criteria']
          if (!Array.isArray(criteria) || criteria.length === 0) refuse('malformed-payload', 'review requires criteria')
          const seen = new Set<string>()
          for (const raw of criteria) {
            const criterion = record(raw, 'review criterion')
            assertClosedKeys(criterion, ['criterionId', 'statement'], 'review criterion')
            const id = text(criterion, 'criterionId', 'review criterion')
            text(criterion, 'statement', 'review criterion')
            if (seen.has(id)) refuse('malformed-payload', 'duplicate review criterion')
            seen.add(id)
          }
          const model = record(row['model'], 'review model')
          assertClosedKeys(model, ['provider', 'model'], 'review model')
          text(model, 'provider', 'review model')
          text(model, 'model', 'review model')
          const method = record(row['method'], 'review method')
          assertClosedKeys(method, ['environmentId', 'revisionId', 'digest'], 'review method')
          text(method, 'environmentId', 'review method')
          text(method, 'revisionId', 'review method')
          digest(method, 'digest', 'review method')
          for (const key of ['agentId', 'identity', 'sessionId', 'workspace']) text(row, key, where)
          return row as unknown as Omit<ReviewRun, 'reviewId' | 'status' | 'children'>
        },
        reduce: (state, envelope, payload) => {
          if (state.reviewId !== undefined) refuse('illegal-transition', 'review already started')
          return { ...payload, reviewId: envelope.subject, status: 'running', children: [] }
        },
      }),
      'review/decomposed': defineKind<ReviewRun, { children: readonly DecompositionChild[] }, {}>({
        guarantees: { appended: true },
        emitter: 'scheduler',
        members: ['children'],
        nested: {},
        parse: (raw) => {
          const row = record(raw, 'review decomposition')
          if (!Array.isArray(row['children'])) refuse('malformed-payload', 'evidence decomposition requires an array')
          return { children: row['children'] as DecompositionChild[] }
        },
        reduce: (state, envelope, payload) => {
          if (state.status !== 'running' || state.identity !== envelope.actor)
            refuse('not-responsible', 'only the working reviewer can request evidence')
          const children = assertDecomposition(
            [...state.children, ...payload.children],
            { criteria: state.criteria },
            state.reviewId,
          )
          return { ...state, children }
        },
      }),
      'review/completed': defineKind<ReviewRun, { findings: readonly Finding[]; result: FileAttachmentRef }, {}>({
        guarantees: { appended: true },
        emitter: REVIEW_ROLE,
        members: ['findings', 'result'],
        nested: {},
        parse: (raw) => {
          const row = record(raw, 'review completion')
          const result = record(row['result'], 'review result')
          assertClosedKeys(result, ['attachmentId', 'name', 'bytes'], 'review result')
          if (
            !/^sha256:[0-9a-f]{64}$/.test(text(result, 'attachmentId', 'review result')) ||
            !Number.isSafeInteger(result['bytes']) ||
            (result['bytes'] as number) < 0
          )
            refuse('malformed-payload', 'invalid review result attachment')
          text(result, 'name', 'review result')
          return { findings: readFindings(row['findings']), result: result as unknown as FileAttachmentRef }
        },
        reduce: (state, envelope, payload) => {
          if (state.status !== 'running' || state.identity !== envelope.actor)
            refuse('not-responsible', 'only the assigned reviewer can complete its Run')
          if (
            payload.findings.length !== state.criteria.length ||
            state.criteria.some((c) => !payload.findings.some((f) => f.criterionId === c.criterionId))
          )
            refuse('unadjudicated-criterion', 'review must decide every frozen criterion exactly once')
          return { ...state, status: 'completed', ...payload }
        },
      }),
      'review/failed': defineKind<ReviewRun, { reason: string }, {}>({
        guarantees: { appended: true },
        emitter: 'scheduler',
        members: ['reason'],
        nested: {},
        parse: (raw) => ({ reason: text(record(raw, 'review failure'), 'reason', 'review failure') }),
        reduce: (state, _envelope, payload) => {
          if (state.status !== 'running') refuse('illegal-transition', 'only a running review can fail')
          return { ...state, status: 'failed', failure: payload.reason }
        },
      }),
    },
  })
}
