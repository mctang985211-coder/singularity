/**
 * The model-request assembly wiring (A2 §D/§9, dispatch subgoal 3): one
 * `system-prompt/assemble` waterfall listener that puts this package's
 * projections in front of the model of every bound session.
 *
 * What goes where, and why it goes there:
 *
 * - The immutable half — the caller's contract, the root briefing, the handoff —
 *   becomes the `singularity:worker-contract` system-prompt **section** (order
 *   80, the name the retired contract-reinjection used). A section is what the
 *   loop reprojects into surface node 0, so the contract survives compaction
 *   instead of living in a spawn prompt a fold can shadow. The listener replaces
 *   the section *by name*, so repeated assemblies carry one copy, never a stack.
 * - The dynamic half — run state, gate phase, recovery marker, related tasks —
 *   is appended to `assembly.contexts`, DSH's runtime-context plane: it lands in
 *   the durable snapshot the loop deduplicates, so an unchanged projection
 *   accumulates no session events. `includeRuntimeContext: false` suppresses
 *   this plane in DSH itself; this listener never works around that.
 *
 * Who gets what: a worker (a replay and a resumed run included) gets both
 * halves; an activated root gets its contract section; a reviewer gets the
 * delegated contract section (the review-only label is the projection's own).
 * A root before activation, a plain graph member, and a session outside this
 * domain are passed through untouched — their assembly is somebody else's
 * business. A diagnostic assembly (no `context.agent`) is always passed
 * through. When a bound caller's projection refuses, the listener throws an
 * error named after the refusal (`context-too-large`, `unreadable`, …): a
 * request whose core contract cannot be admitted whole is refused, never
 * assembled from a cut or invented contract.
 * @module @dangosys/dsh-singularity-context/assembly
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssembleContext, AssembledSection, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { SingularityContextService } from './index.ts'
import type { ProjectedReadRefused } from './refusals.ts'

/**
 * Section name of the assembled contract. The name the old contract-reinjection
 * registered, kept: it is the one slot the immutable half has ever had, now
 * filled from the store at every assembly instead of rendered once at spawn.
 */
export const WORKER_CONTRACT_SECTION = 'singularity:worker-contract'

/** Placement: after the root's `singularity:root` (70) and the worker policy's `singularity:worker` (75). */
export const WORKER_CONTRACT_ORDER = 80

/** The dynamic half's context name on the runtime-context plane. */
export const STATE_CONTEXT_NAME = 'singularity:state'

/** Placement among the runtime contexts, after the centrally allocated ones (`CONTEXT_ORDERS` ends at 120). */
export const STATE_CONTEXT_ORDER = 130

/**
 * The sections that sort at or ahead of {@link WORKER_CONTRACT_ORDER}, by name
 * (`AssembledSection` carries no order, so the insertion point is computed from
 * who these are): the harness identity, the deployment persona prefix, and this
 * deployment's two role sections. The contract goes right behind them, ahead of
 * the tool guidance that starts at order 500.
 */
const PRE_CONTRACT_SECTIONS: ReadonlySet<string> = new Set([
  'harness:identity',
  'deployment:persona-prefix',
  'singularity:root',
  'singularity:worker',
])

/** The error a refused assembly throws: the refusal is its name, the detail its message. */
export class AssemblyRefusalError extends Error {
  constructor(readonly refusal: ProjectedReadRefused['refusal'], detail: string) {
    super(detail)
    this.name = 'AssemblyRefusalError'
  }
}

/** Throw the projection's refusal as the named rejection of this model request. */
function throwRefusal(read: ProjectedReadRefused): never {
  throw new AssemblyRefusalError(read.refusal, `system-prompt assembly refused (${read.refusal}): ${read.detail}`)
}

/** The section the immutable half becomes: literal text, never variable-interpolated. */
function contractSection(text: string): AssembledSection {
  return { name: WORKER_CONTRACT_SECTION, text, interpolate: false }
}

/**
 * Replace the contract section by name, or insert it at its order. The assembly
 * arrives sorted; the insertion point is the first section that is not one of
 * the known pre-contract ones.
 */
function withContractSection(assembly: PromptAssembly, text: string): void {
  const existing = assembly.sections.find(section => section.name === WORKER_CONTRACT_SECTION)
  if (existing !== undefined) {
    existing.text = text
    existing.interpolate = false
    return
  }
  let index = 0
  while (index < assembly.sections.length && PRE_CONTRACT_SECTIONS.has(assembly.sections[index]!.name)) index += 1
  assembly.sections.splice(index, 0, contractSection(text))
}

/** Append the dynamic half to the runtime-context plane; an unchanged name is replaced, never duplicated. */
function withStateContext(assembly: PromptAssembly, text: string): void {
  const existing = assembly.contexts.find(context => context.name === STATE_CONTEXT_NAME)
  if (existing !== undefined) {
    existing.text = text
    return
  }
  assembly.contexts.push({ name: STATE_CONTEXT_NAME, text })
}

/**
 * The one assembly step this package runs (see the module doc for who gets
 * what). Mutates the assembly and delegates; a bound caller whose projection
 * refuses rejects the whole waterfall, which is what refuses the model request.
 */
export async function assembleSingularityContext(
  service: SingularityContextService,
  assembly: PromptAssembly,
  context: AssembleContext,
  next: () => Promise<PromptAssembly>,
): Promise<PromptAssembly> {
  // A diagnostic assembly names no agent: nothing about a project is injected
  // into a request nobody is making.
  const agent: Agent | undefined = context.agent
  if (agent === undefined) return next()
  const sessionId = String(agent.id)
  const resolution = await service.resolveCaller(sessionId, context.signal)

  switch (resolution.kind) {
    case 'worker': {
      const contract = await service.contractProjection(sessionId, context.signal)
      if (!contract.ok) throwRefusal(contract)
      const dynamic = await service.dynamicProjection(sessionId, context.signal)
      if (!dynamic.ok) throwRefusal(dynamic)
      withContractSection(assembly, contract.text)
      withStateContext(assembly, dynamic.text)
      return next()
    }
    case 'root': {
      // Not activated yet: the root prompt and the intake tools are this
      // session's whole context, exactly as before this package existed.
      if (resolution.task === undefined) return next()
      const contract = await service.contractProjection(sessionId, context.signal)
      if (!contract.ok) throwRefusal(contract)
      withContractSection(assembly, contract.text)
      return next()
    }
    case 'reviewer': {
      const contract = await service.contractProjection(sessionId, context.signal)
      if (!contract.ok) throwRefusal(contract)
      withContractSection(assembly, contract.text)
      return next()
    }
    // A plain member and an unbound session assemble what their composition
    // gives them: a member has no contract of its own to inject, and a session
    // outside this domain is not this package's caller.
    case 'member':
    case 'unbound':
      return next()
  }
}
