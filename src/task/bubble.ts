/**
 * The bubble: the execution context one run happened in, declared before it is judged.
 *
 * A bubble is the **input snapshot** — the named content digests the work was done against — plus a
 * reference to the workspace. That is the minimum this phase needs, and it is deliberately not a
 * sandbox platform: no mounts, no caches, no `$DSH_HOME` handling. Upstream owns confinement, and
 * the frozen repo's own bubble docstring claimed a hiding its code never performed.
 *
 * Why it exists at all is the binding: **a verdict must name the inputs it was formed against, and
 * they must be the ones the run declared.** Without that, swapping an input after the fact leaves an
 * old `pass` standing. The binding is a pure same-subject check, because the bubble and the verdict
 * are both facts about the task.
 *
 * The declared input digests are a *claim about content*, not proof of it. Proving that the bytes
 * actually read hash to those digests is the execution adapter's job at the point of judging; a
 * string comparison here cannot establish it, and this module does not pretend otherwise.
 *
 * @module singularity-core/task/bubble
 */

import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type KindRule } from '../protocol/registry.ts'
import type { TaskState } from './protocol.ts'
import { record, requireContractOf, requireRun, text } from './shape.ts'

/** One named input of an execution: a name the verdict echoes and the content digest it ran on. */
export interface BubbleInput {
  readonly name: string
  readonly digest: string
}

/** The declared execution context of one run. */
export interface Bubble {
  readonly runId: string
  readonly inputs: readonly BubbleInput[]
  readonly workspace: { readonly kind: string; readonly ref: string }
  readonly at: string
}

export const BUBBLE_MEMBERS = ['runId', 'inputs', 'workspace'] as const
export const WORKSPACE_MEMBERS = ['kind', 'ref'] as const
export const BUBBLE_INPUT_MEMBERS = ['name', 'digest'] as const

const DIGEST = /^[0-9a-f]{64}$/

/** Read one closed list of named input digests. Names are unique; a repeat is refused, not merged. */
export function inputList(raw: unknown, where: string): readonly BubbleInput[] {
  if (!Array.isArray(raw)) refuse('malformed-payload', `${where} must be an array of named inputs, got ${raw === null ? 'null' : typeof raw}`)
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    const at = `${where}[${index}]`
    const source = record(entry, at)
    assertClosedKeys(source, BUBBLE_INPUT_MEMBERS, at)
    const name = text(source, 'name', at)
    const digest = text(source, 'digest', at)
    if (!DIGEST.test(digest)) refuse('malformed-payload', `${at}.digest must be a sha256 hex content digest, got ${JSON.stringify(digest)}`)
    if (seen.has(name)) refuse('malformed-payload', `${where} names input ${JSON.stringify(name)} twice; one input has one digest`)
    seen.add(name)
    return { name, digest }
  })
}

/**
 * The binding: a verdict's inputs must be exactly the run's declared inputs.
 *
 * Order-sensitive and total, because "the same inputs" is the only thing that makes an old verdict
 * about this run rather than about a different one.
 */
export function assertInputsBound(bubble: Bubble | undefined, declared: readonly BubbleInput[], where: string): void {
  if (bubble === undefined)
    refuse(
      'illegal-transition',
      `${where} judges a run whose execution context was never declared; open a bubble for the run before anything is decided about it`,
    )
  if (bubble.inputs.length !== declared.length)
    refuse(
      'evidence-input-mismatch',
      `${where} declares ${declared.length} input(s) but the run's bubble declares ${bubble.inputs.length}; the verdict must be formed on exactly what the run declared`,
    )
  for (const [index, expected] of bubble.inputs.entries()) {
    const actual = declared[index]
    if (actual === undefined || actual.name !== expected.name || actual.digest !== expected.digest)
      refuse(
        'evidence-input-mismatch',
        `${where} declares input ${index} as ${JSON.stringify(actual?.name ?? null)}=${actual?.digest.slice(0, 12) ?? 'null'}…, but the run's bubble declares ${JSON.stringify(expected.name)}=${expected.digest.slice(0, 12)}…`,
      )
  }
}

/** `bubble/opened`: one run's execution context, declared once before it is judged. */
export function bubbleOpenedKind(kind: string, emitter: string): KindRule<TaskState> {
  return defineKind<TaskState, { runId: string; inputs: readonly BubbleInput[]; workspace: { kind: string; ref: string } }>({
    guarantees: { appended: true },
    emitter,
    parse: raw => {
      const where = `${kind} payload`
      const source = record(raw, where)
      assertClosedKeys(source, BUBBLE_MEMBERS, where)
      const workspace = record(source['workspace'], `${where}.workspace`)
      assertClosedKeys(workspace, WORKSPACE_MEMBERS, `${where}.workspace`)
      return {
        runId: text(source, 'runId', where),
        inputs: inputList(source['inputs'], `${where}.inputs`),
        workspace: { kind: text(workspace, 'kind', `${where}.workspace`), ref: text(workspace, 'ref', `${where}.workspace`) },
      }
    },
    reduce: (state, envelope, payload) => {
      const where = `${kind} #${envelope.seq}`
      requireContractOf(state, where, envelope.subject)
      const run = requireRun(state, payload.runId, where)
      if (run.status !== 'running')
        refuse('illegal-transition', `${where} opens an execution context for run "${payload.runId}", which already settled ${run.status}`)
      if (run.bubble !== undefined)
        refuse(
          'illegal-transition',
          `${where} opens a second execution context for run "${payload.runId}" (the first was opened at ${run.bubble.at}); an execution happened in one context`,
        )
      return {
        ...state,
        runs: {
          ...state.runs,
          [payload.runId]: { ...run, bubble: { runId: payload.runId, inputs: payload.inputs, workspace: payload.workspace, at: envelope.at } },
        },
      }
    },
  })
}
