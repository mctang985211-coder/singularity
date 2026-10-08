/**
 * One recorded coordination delegation, and the one seam that reads it: the
 * exact fields the ledger holds, with the role required and never assumed.
 * @module @dangosys/dsh-singularity-context/bindings-coordination
 */

import { SESSION_NOT_IN_GRAPH } from '@dangosys/dsh-singularity-graphs'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { message, type NamedRefusal } from '../refusals.ts'
import { isGraphMember, type BindingDeps, type GraphRecordFacts } from './types.ts'

/** The coordination responsibilities a delegation can carry. */
export type CoordinationRole = 'reviewer' | 'supervisor' | 'coordinator'

/** One coordination binding: the role and its source, exact to the Run, all of them required. */
export interface CoordinationBinding {
  /** What the delegated session is responsible for; a row without one is refused, never a default. */
  readonly role: CoordinationRole
  /** The task the delegation names as its source. */
  readonly sourceTaskId: string
  /** The exact source Run; null means the task never ran. */
  readonly sourceRunId: string | null
  /** The session that recorded the delegation. */
  readonly actor: string
  /** The delegated root task domain, checked against the graph the session is published in. */
  readonly rootStoreId: string
  readonly at: string
}

/** Where a coordination binding is read from: the ledger finds the rows, this package reads them. */
export interface CoordinationBindingSource {
  read(sessionId: string): Promise<CoordinationBinding | undefined>
}

/** Why a binding source could not answer: a conflicting ledger, one this process cannot read, or a role that is missing. */
type CoordinationBindingFailure = 'binding-conflict' | 'unreadable' | 'role-missing'

/** What a source raises instead of picking a row: a conflict, an unreadable ledger, or a binding with no role. */
export class CoordinationBindingError extends Error {
  readonly kind: CoordinationBindingFailure

  constructor(kind: CoordinationBindingFailure, message: string) {
    super(message)
    this.name = 'CoordinationBindingError'
    this.kind = kind
  }
}

/** The refusal a binding failure is reported under; the vocabulary has no separate name for a missing role. */
const REFUSAL_OF: Readonly<Record<CoordinationBindingFailure, NamedRefusal>> = {
  'binding-conflict': 'binding-conflict',
  unreadable: 'unreadable',
  'role-missing': 'binding-conflict',
}

/** The answer one binding read can give: nothing, one record, or a named refusal. */
export type CoordinationRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'record'; readonly record: CoordinationBinding }
  | { readonly kind: 'refused'; readonly refusal: NamedRefusal; readonly detail: string }

/** The failure one binding source reported, from the error's own name-plus-`kind` contract. */
function coordinationFailure(error: unknown): CoordinationBindingFailure | undefined {
  const kind = (error as { kind?: unknown } | undefined)?.kind
  if (kind !== 'binding-conflict' && kind !== 'unreadable' && kind !== 'role-missing') return undefined
  if (error instanceof Error && error.name === 'CoordinationBindingError') return kind
  return undefined
}

/** The role a row carries, read at run time: the record's own field is never taken on trust. */
function roleOf(record: CoordinationBinding): CoordinationRole | undefined {
  const role = (record as { role?: unknown }).role
  return role === 'reviewer' || role === 'supervisor' || role === 'coordinator' ? role : undefined
}

/** The one delegation recorded for a session; a source that cannot answer is reported as-is. */
export async function readCoordination(deps: BindingDeps, sessionId: string): Promise<CoordinationRead> {
  const source = deps.coordinationSource
  if (source === undefined) return { kind: 'none' }
  let record: CoordinationBinding | undefined
  try {
    record = await source.read(sessionId)
  } catch (error) {
    const failure = coordinationFailure(error)
    if (failure !== undefined) return { kind: 'refused', refusal: REFUSAL_OF[failure], detail: message(error) }
    return {
      kind: 'refused',
      refusal: 'unreadable',
      detail: `the coordination binding source could not be read: ${message(error)}`,
    }
  }
  if (record === undefined) return { kind: 'none' }
  if (roleOf(record) === undefined) {
    return {
      kind: 'refused',
      refusal: REFUSAL_OF['role-missing'],
      detail:
        `session "${sessionId}" is recorded under a coordination delegation that names no role; a delegation is ` +
        'granted for the responsibility it records, and "reviewer" is never assumed for it.',
    }
  }
  return { kind: 'record', record }
}

/** Whether the session a delegation names as its delegator is really a session of the graph it delegated into. */
export type DelegatorStanding =
  | { readonly kind: 'member' }
  | { readonly kind: 'refused'; readonly refusal: NamedRefusal; readonly detail: string }

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
        `the delegator "${actor}" of the coordination delegation of session "${sessionId}" cannot be checked against ` +
        `graph "${graph.id}": ${message(error)}. An unverifiable delegator is not an authorization.`,
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
          `the coordination delegation of session "${sessionId}" into graph "${graph.id}" (store ` +
          `"${rootTaskStoreId(graph.rootSessionId)}") records "${actor}" as its delegator, and no graph in this ` +
          'deployment publishes that session; a delegation is granted by a session of the graph it delegates into, ' +
          'not by a name in a file.',
      }
    }
    return {
      kind: 'refused',
      refusal: 'unreadable',
      detail:
        `the delegator "${actor}" of the coordination delegation of session "${sessionId}" cannot be placed: ${message(error)}. ` +
        'A delegator whose ownership cannot be read is not an authorization.',
    }
  }
  return {
    kind: 'refused',
    refusal: 'cross-graph',
    detail:
      `the coordination delegation of session "${sessionId}" into graph "${graph.id}" (store ` +
      `"${rootTaskStoreId(graph.rootSessionId)}") was recorded by "${actor}", which graph "${graph.id}" does not ` +
      `publish: the delegator belongs to graph "${elsewhere?.id ?? '(unknown)'}", and a delegation never opens ` +
      "another graph's read domain.",
  }
}
