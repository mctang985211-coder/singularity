/** Reading a reviewer's delegation from the one injected ledger seam. @module @dangosys/dsh-singularity-context/bindings-reviewer */

import { SESSION_NOT_IN_GRAPH } from '@dangosys/dsh-singularity-graphs'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { message, type NamedRefusal } from '../refusals.ts'
import { isGraphMember, type BindingDeps, type GraphRecordFacts, type ReviewerBindingRecord } from './types.ts'

/** The answer one delegation read can give: nothing, one record, or a named refusal. */
type DelegationRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'record'; readonly record: ReviewerBindingRecord }
  | { readonly kind: 'refused'; readonly refusal: 'binding-conflict' | 'unreadable'; readonly detail: string }

/** The failure one binding source reported, from the error's own name-plus-`kind` contract. */
function reviewerFailure(error: unknown): 'binding-conflict' | 'unreadable' | undefined {
  const kind = (error as { kind?: unknown } | undefined)?.kind
  if (kind !== 'binding-conflict' && kind !== 'unreadable') return undefined
  if (error instanceof Error && error.name === 'ReviewerBindingError') return kind
  return undefined
}

/** The one delegation recorded for a session; a source that cannot answer is reported as-is. */
export async function readDelegation(deps: BindingDeps, sessionId: string): Promise<DelegationRead> {
  const source = deps.reviewerSource
  if (source === undefined) return { kind: 'none' }
  let record: ReviewerBindingRecord | undefined
  try {
    record = await source.read(sessionId)
  } catch (error) {
    const failure = reviewerFailure(error)
    if (failure !== undefined) return { kind: 'refused', refusal: failure, detail: message(error) }
    return {
      kind: 'refused',
      refusal: 'unreadable',
      detail: `the reviewer binding source could not be read: ${message(error)}`,
    }
  }
  return record === undefined ? { kind: 'none' } : { kind: 'record', record }
}

/** Whether the session a delegation names as its delegator is really a session of the graph it delegated into. */
type DelegatorStanding =
  { readonly kind: 'member' } | { readonly kind: 'refused'; readonly refusal: NamedRefusal; readonly detail: string }

/** The delegator check is the registry's published members, and a registry that cannot be read refuses. */
export async function delegatorStanding(
  deps: BindingDeps,
  sessionId: string,
  graph: GraphRecordFacts,
  actor: string,
): Promise<DelegatorStanding> {
  let member: boolean
  try {
    member = await isGraphMember(deps.graphs, graph.id, actor)
  } catch (error) {
    return {
      kind: 'refused',
      refusal: 'unreadable',
      detail:
        `the delegator "${actor}" of the review delegation of session "${sessionId}" cannot be checked against graph ` +
        `"${graph.id}": ${message(error)}. An unverifiable delegator is not an authorization.`,
    }
  }
  if (member) return { kind: 'member' }
  let elsewhere: GraphRecordFacts | undefined
  try {
    elsewhere = await deps.graphs.graphForSession(actor)
  } catch (error) {
    if ((error as { code?: unknown } | undefined)?.code === SESSION_NOT_IN_GRAPH) {
      return {
        kind: 'refused',
        refusal: 'unbound',
        detail:
          `the delegation of session "${sessionId}" into graph "${graph.id}" (store ` +
          `"${rootTaskStoreId(graph.rootSessionId)}") records "${actor}" as its delegator, and no graph in this ` +
          'deployment publishes that session; a delegation is granted by a session of the graph it delegates into, ' +
          'not by a name in a file.',
      }
    }
    return {
      kind: 'refused',
      refusal: 'unreadable',
      detail:
        `the delegator "${actor}" of the review delegation of session "${sessionId}" cannot be placed: ${message(error)}. ` +
        'A delegator whose ownership cannot be read is not an authorization.',
    }
  }
  return {
    kind: 'refused',
    refusal: 'cross-graph',
    detail:
      `the delegation of session "${sessionId}" into graph "${graph.id}" (store ` +
      `"${rootTaskStoreId(graph.rootSessionId)}") was recorded by "${actor}", which graph "${graph.id}" does not ` +
      `publish: the delegator belongs to graph "${elsewhere?.id ?? '(unknown)'}", and a delegation never opens ` +
      "another graph's read domain.",
  }
}
