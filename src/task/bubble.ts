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
 * **The isolation manifest is required, not decorative.** Fixing only the skill text or a tool's
 * name does not fix what ran: the tool's implementation can be rebuilt behind its name, and the
 * model behind a route can be swapped. So a bubble also declares the model identity, every tool's
 * content digest, and the observable external conditions. A bubble that cannot say what its tools
 * were is not a reproducible execution context, so the reducer refuses it rather than defaulting.
 * The tool digest is the same idea as a criterion's `implementationDigest`: a name a deployment can
 * re-point is not an identity.
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
  /** The model that actually ran. Never a default: an unnamed model is an unrecorded condition. */
  readonly model: string
  /** Every tool the execution could reach, by name, version and the digest of its implementation. */
  readonly tools: readonly BubbleTool[]
  /** The observable external conditions, each named. Empty means "none observed", not "unrecorded". */
  readonly conditions: readonly string[]
  readonly at: string
}

/** One tool an execution could reach: a name a deployment can re-point, and the content that ran. */
export interface BubbleTool {
  readonly name: string
  readonly implementationDigest: string
  readonly version: string
}

export const BUBBLE_MEMBERS = ['runId', 'inputs', 'workspace', 'model', 'tools', 'conditions'] as const
export const WORKSPACE_MEMBERS = ['kind', 'ref'] as const
export const BUBBLE_INPUT_MEMBERS = ['name', 'digest'] as const
/** The closed shape of one tool. Not exported: what is exported is the surface the stack uses. */
const BUBBLE_TOOL_MEMBERS = ['name', 'implementationDigest', 'version'] as const

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

/** Every tool the execution could reach. Names are unique: two tools with one name are one tool. */
function toolList(raw: unknown, where: string): readonly BubbleTool[] {
  if (!Array.isArray(raw))
    refuse('malformed-payload', `${where} must be an array of the tools the execution could reach, got ${raw === null ? 'null' : typeof raw}`)
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    const at = `${where}[${index}]`
    const source = record(entry, at)
    assertClosedKeys(source, BUBBLE_TOOL_MEMBERS, at)
    const name = text(source, 'name', at)
    if (seen.has(name)) refuse('malformed-payload', `${where} names tool ${JSON.stringify(name)} twice; one name was one implementation`)
    seen.add(name)
    const implementationDigest = text(source, 'implementationDigest', at)
    if (!DIGEST.test(implementationDigest))
      refuse('malformed-payload', `${at}.implementationDigest must be a sha256 hex content digest, got ${JSON.stringify(implementationDigest)}`)
    return { name, implementationDigest, version: text(source, 'version', at) }
  })
}

/** The observable external conditions, each named once. An empty list is a claim, not an omission. */
function conditionList(raw: unknown, where: string): readonly string[] {
  if (!Array.isArray(raw)) refuse('malformed-payload', `${where} must be an array of named conditions, got ${raw === null ? 'null' : typeof raw}`)
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    const at = `${where}[${index}]`
    if (typeof entry !== 'string' || entry.length === 0)
      refuse('malformed-payload', `${at} must be a non-empty string, got ${entry === null ? 'null' : typeof entry}`)
    if (seen.has(entry)) refuse('malformed-payload', `${where} names condition ${JSON.stringify(entry)} twice; a condition is stated once`)
    seen.add(entry)
    return entry
  })
}

/** `bubble/opened`: one run's execution context, declared once before it is judged. */
export function bubbleOpenedKind(kind: string, emitter: string): KindRule<TaskState> {
  return defineKind<
    TaskState,
    { runId: string; inputs: readonly BubbleInput[]; workspace: { kind: string; ref: string }; model: string; tools: readonly BubbleTool[]; conditions: readonly string[] }
  >({
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
        model: text(source, 'model', where),
        tools: toolList(source['tools'], `${where}.tools`),
        conditions: conditionList(source['conditions'], `${where}.conditions`),
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
          [payload.runId]: {
            ...run,
            bubble: {
              runId: payload.runId,
              inputs: payload.inputs,
              workspace: payload.workspace,
              model: payload.model,
              tools: payload.tools,
              conditions: payload.conditions,
              at: envelope.at,
            },
          },
        },
      }
    },
  })
}
