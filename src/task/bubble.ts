import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { defineKind, type KindRule, type MemberSet } from '../protocol/registry.ts'
import type { TaskState } from './protocol.ts'
import { requireResponsible } from './responsibility.ts'
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

export function inputList(raw: unknown, where: string, members: MemberSet): readonly BubbleInput[] {
  if (!Array.isArray(raw)) refuse('malformed-payload', `${where} must be an array of named inputs, got ${raw === null ? 'null' : typeof raw}`)
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    const at = `${where}[${index}]`
    const source = record(entry, at)
    assertClosedKeys(source, members, at)
    const name = text(source, 'name', at)
    const digest = text(source, 'digest', at)
    if (!DIGEST.test(digest)) refuse('malformed-payload', `${at}.digest must be a sha256 hex content digest, got ${JSON.stringify(digest)}`)
    if (seen.has(name)) refuse('malformed-payload', `${where} names input ${JSON.stringify(name)} twice; one input has one digest`)
    seen.add(name)
    return { name, digest }
  })
}

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

function toolList(raw: unknown, where: string, members: MemberSet): readonly BubbleTool[] {
  if (!Array.isArray(raw))
    refuse('malformed-payload', `${where} must be an array of the tools the execution could reach, got ${raw === null ? 'null' : typeof raw}`)
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    const at = `${where}[${index}]`
    const source = record(entry, at)
    assertClosedKeys(source, members, at)
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
    { runId: string; inputs: readonly BubbleInput[]; workspace: { kind: string; ref: string }; model: string; tools: readonly BubbleTool[]; conditions: readonly string[] },
    { workspace: MemberSet; inputs: MemberSet; tools: MemberSet }
  >({
    guarantees: { appended: true },
    members: BUBBLE_MEMBERS,
    // `inputs[]`, `tools[]` and `workspace` are closed by their own readers with the sets named here:
    // this declaration is handed to each of them, so it is what the log enforces rather than a second
    // copy printed beside the one the reader uses.
    nested: { workspace: WORKSPACE_MEMBERS, inputs: BUBBLE_INPUT_MEMBERS, tools: BUBBLE_TOOL_MEMBERS },
    emitter,
    parse: (raw, where, nested) => {
      const source = record(raw, where)
      const workspace = record(source['workspace'], `${where}.workspace`)
      assertClosedKeys(workspace, nested.workspace, `${where}.workspace`)
      return {
        runId: text(source, 'runId', where),
        inputs: inputList(source['inputs'], `${where}.inputs`, nested.inputs),
        workspace: { kind: text(workspace, 'kind', `${where}.workspace`), ref: text(workspace, 'ref', `${where}.workspace`) },
        model: text(source, 'model', where),
        tools: toolList(source['tools'], `${where}.tools`, nested.tools),
        conditions: conditionList(source['conditions'], `${where}.conditions`),
      }
    },
    reduce: (state, envelope, payload) => {
      const where = `${kind} #${envelope.seq}`
      requireContractOf(state, where, envelope.subject)
      const run = requireRun(state, payload.runId, where)
      // The execution context belongs to the attempt, and the attempt to the agent answerable for
      // it: nobody else declares what this run executed against.
      requireResponsible(state, envelope.actor, where)
      if (run.status !== 'running')
        refuse('illegal-transition', `${where} opens an execution context for run "${payload.runId}", which already settled ${run.status}`)
      if (run.stage !== 'working')
        refuse('illegal-transition', `${where} cannot open a bubble for run "${payload.runId}" in ${run.stage}`)
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
